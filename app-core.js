// app-core.js — Fix 116
// app.js — Hornet Mapper NL v6.1.0 (hybride realtime + veilige UI binding)
// ----------------------------------------------------------------------------
// Vereist (door index.html alléén app.js te laden):
// ./sync-engine.js → importeert ./firebase.js → importeert ./config.js
// Leaflet + Geoman (globaal L) moeten vóór app.js geladen zijn.
// 
// Belangrijk: alle DOM‑bindingen pas NA DOMContentLoaded.
// 
// ----------------------------------------------------------------------------
import { auth } from './firebase.js';
import { getFirestore, doc, getDoc, setDoc, collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app } from './firebase.js';
const _db = getFirestore(app);

// displayName van ingelogde gebruiker (opgehaald uit roles/{uid})
let _currentDisplayName = '';
let _currentRole   = '';
let _currentZones  = [];   // genormaliseerde zones van ingelogde gebruiker
let _zoneManagers  = {};   // { 'Zeist': 'Jan de Vries', ... } — geladen bij boot
function canEdit()   { return _currentRole === 'admin' || _currentRole === 'manager'; }  // polygonen/gebieden
function getZoneManagerName(zoneId) {
  const z = normalizeZone(zoneId || '') || normalizeZone($('sel-group')?.value || DEFAULT_GROUP);
  const name = _zoneManagers[z] || null;
  if(!name) console.log('[app] geen beheerder gevonden voor zone:', z, 'managers:', _zoneManagers);
  return name;
}
function canWrite()  { return _currentRole === 'admin' || _currentRole === 'manager' || _currentRole === 'volunteer'; }  // iconen

import {
  setActiveScope,
  listenToCloudChanges,
  saveMarkerToCloud, deleteMarkerFromCloud,
  saveLineToCloud, deleteLineFromCloud,
  saveSectorToCloud, deleteSectorFromCloud,
  savePolygonToCloud, deletePolygonFromCloud
} from "./sync-engine.js";
// ======================= Kleine helpers =======================
function $(id) { return document.getElementById(id); }
function on(el, ev, fn) { if (el) el.addEventListener(ev, fn, { passive: true }); }
function req(id) { const el = $(id); if (!el) console.warn(`[UI] Element met id="${id}" niet gevonden`); return el; }
function nowISODate() { return new Date().toISOString().slice(0,10); }
function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`; }
function debounceEventGate(msGetter){
  let last = 0;
  return () => {
    const ms = msGetter();
    const t = Date.now();
    if (t - last < ms) return true;
    last = t;
    return false;
  };
}
// ======================= Status UI =======================
const statusSW = $('status-sw');
const statusGeo = $('status-geo');
function setStatus(el, text, cls){ if(!el) return; el.textContent=text; el.classList.remove('ok','warn','err'); if(cls) el.classList.add(cls); }
function updateSWStatus(){
  try{
    if(!('serviceWorker' in navigator)){ setStatus(statusSW,'SW: niet ondersteund','warn'); return; }
    const st = navigator.serviceWorker.controller ? 'actief' : 'geregistreerd';
    setStatus(statusSW, `SW: ${st}`, 'ok');
  }catch{}
}
// ======================= Debounce =======================
const SOFT_MS=150; let DEBOUNCE_MS=SOFT_MS;
const shouldDebounce = debounceEventGate(()=>DEBOUNCE_MS);
// ======================= Map & Layers =======================
let map; // maak globaal voor jouw tests (typeof map === "object")
const markersGroup = L.featureGroup();
const linesGroup = L.featureGroup();
const circlesGroup = L.featureGroup();
const handlesGroup = L.featureGroup();
const polygonsGroup = L.featureGroup();
let allMarkers=[], allLines=[], allSectors=[];
function initMap(){
  map = L.map('map', { zoomControl: true, rotate: true, rotateControl: false }).setView([52.1, 5.3], 8);
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19, attribution:'© OpenStreetMap-bijdragers'
  });
  const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
    maxZoom:19, attribution:'© Esri — satelliet'
  });
  osmLayer.addTo(map);

  // ── Schaal onderaan de kaart ──────────────────────────────────────────────
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

  // ── Locatie knop ─────────────────────────────────────────────────────────
  let _locMarker = null;
  const locBtn = L.control({ position: 'topleft' });
  let _locBtnEl = null; // directe referentie naar de knop
  locBtn.onAdd = function() {
    const btn = L.DomUtil.create('button', 'leaflet-bar leaflet-control');
    btn.innerHTML = '📍';
    btn.title = 'Zoom naar mijn locatie';
    btn.style.cssText = 'width:34px;height:34px;line-height:34px;text-align:center;font-size:16px;cursor:pointer;background:#fff;border:none;display:block';
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => {
      btn.innerHTML = '⏳';
      map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true });
    });
    _locBtnEl = btn;
    return btn;
  };
  locBtn.addTo(map);
  map.on('locationfound', e => {
    if (_locMarker) map.removeLayer(_locMarker);
    _locMarker = L.circleMarker(e.latlng, {
      radius: 8, color: '#0aa879', fillColor: '#0aa879', fillOpacity: 0.8, weight: 2
    }).addTo(map).bindPopup('Jouw locatie').openPopup();
    if (_locBtnEl) _locBtnEl.innerHTML = '📍';
  });
  map.on('locationerror', () => {
    if (_locBtnEl) _locBtnEl.innerHTML = '📍';
    alert('Locatie niet beschikbaar. Controleer je browserinstellingen.');
  });

  // ── Kompas + rotatie ─────────────────────────────────────────────────────
  let _bearing = 0; // graden, 0 = noord
  const compassCtrl = L.control({ position: 'topleft' });
  compassCtrl.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control compass-control');
    div.title = 'Kompas — sleep om kaart te draaien, klik om naar het noorden te resetten';
    div.style.cssText = 'width:34px;height:34px;background:#fff;display:flex;align-items:center;justify-content:center;user-select:none;pointer-events:none;cursor:default';
    div.innerHTML = '<svg id="compass-svg" width="26" height="26" viewBox="0 0 26 26">'
      + '<circle cx="13" cy="13" r="12" fill="#fff" stroke="#cbd5e1" stroke-width="1.5"/>'
      + '<polygon id="compass-n" points="13,3 10,13 13,11 16,13" fill="#e53e3e"/>'
      + '<polygon id="compass-s" points="13,23 10,13 13,15 16,13" fill="#94a3b8"/>'
      + '<text x="13" y="8" text-anchor="middle" font-size="5" font-weight="bold" fill="#e53e3e">N</text>'
      + '</svg>';
    return div;
  };
  compassCtrl.addTo(map);

  // Kompas volgt deviceorientation op mobiel
  function updateCompassSvg(bearing) {
    const svg = document.getElementById('compass-svg');
    if (svg) svg.style.transform = 'rotate(' + bearing + 'deg)';
  }

  // Kompas op mobiel: volg het kompas van het apparaat
  if (window.DeviceOrientationEvent) {
    const requestCompass = () => {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ vereist expliciete toestemming
        DeviceOrientationEvent.requestPermission().then(state => {
          if (state === 'granted') window.addEventListener('deviceorientation', _onOrientation, true);
        }).catch(() => {});
      } else {
        window.addEventListener('deviceorientation', _onOrientation, true);
      }
    };
    // Aktiveer kompas zodra locatieknop aangeklikt wordt
    const _origLocClick = _locBtnEl;
    document.addEventListener('click', e => {
      if (e.target === _locBtnEl) requestCompass();
    }, { once: false });
  }

  function _onOrientation(e) {
    const heading = e.webkitCompassHeading ?? (e.alpha != null ? (360 - e.alpha) : null);
    if (heading == null) return;
    updateCompassSvg(heading);
  }

  // Satelliet toggle — alleen via kaart contextmenu, geen losse knop
  let _satMode = false;
  markersGroup.addTo(map);
  linesGroup.addTo(map);
  circlesGroup.addTo(map);
  handlesGroup.addTo(map);
  polygonsGroup.addTo(map);
  // Geoman toolbar
  map.pm.addControls({
    position:'topleft',
    drawMarker:false, drawPolyline:false, drawRectangle:false, drawPolygon:true,
    drawCircle:false, drawCircleMarker:false, drawText:false,
    editMode:false, dragMode:false, cutPolygon:false, removalMode:false, rotateMode:false
  });
  map.pm.setGlobalOptions({ finishOn: 'dblclick', snappable: true, allowSelfIntersection: false });

  // Sateliet-knop als custom Geoman control in de toolbar (topleft)
  map.pm.Toolbar.createCustomControl({
    name: 'toggleSat',
    block: 'custom',
    title: 'Wissel kaart / satelliet',
    className: 'pm-icon-sat',
    onClick: () => {
      _satMode = !_satMode;
      if (_satMode) {
        map.removeLayer(osmLayer); satLayer.addTo(map);
        document.querySelector('.pm-icon-sat')?.classList.add('active-sat');
      } else {
        map.removeLayer(satLayer); osmLayer.addTo(map);
        document.querySelector('.pm-icon-sat')?.classList.remove('active-sat');
      }
      // Ook de losse toggle knop rechtsonder bijwerken
      // (toggle knop staat alleen in contextmenu)
    },
    toggle: false,
  });

  // Filter-knop in Geoman toolbar
  map.pm.Toolbar.createCustomControl({
    name: 'openFilter',
    block: 'custom',
    title: 'Filter',
    className: 'pm-icon-filter',
    onClick: () => openFilterModal(),
    toggle: false,
  });
  // SVG direct in de knop injecteren — CSS ::after werkt niet betrouwbaar in Geoman
  setTimeout(() => {
    const filterBtn = document.querySelector('.pm-icon-filter a, .pm-icon-filter button');
    if (filterBtn) {
      filterBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" style="display:block;margin:auto"><path fill="#d97706" d="M3 4h18l-7 9v6l-4-2v-4Z"/></svg>`;
      filterBtn.style.cssText += ';display:flex;align-items:center;justify-content:center;';
    }
  }, 200);

  map.on('zoomend', () => {
    refreshAllMarkerIcons();
    refreshZoomVisibility();
  });

  // Eerste punt markeren bij starten polygoon tekenen
  map.on('pm:drawstart', ({ workingLayer }) => {
    if (!workingLayer) return;
    workingLayer.on('pm:vertexadded', (ev) => {
      // Eerste vertex (index 0) een rode kleur geven
      const markers = workingLayer._markers || [];
      if (markers.length === 1 && markers[0]) {
        const el = markers[0].getElement?.();
        if (el) {
          el.style.background = '#e53e3e';
          el.style.borderColor = '#c53030';
          el.title = 'Eerste punt — klik hier of dubbelklik om te sluiten';
        }
      }
    });
  });
  // Create polygonen → initialiseren + opslaan naar cloud
  map.on('pm:create', (e)=>{
    const layer=e.layer;
    if(e.shape==='Polygon' || e.shape==='Rectangle'){
      polygonsGroup.addLayer(layer);
      initPolygon(layer);
      persistPolygon(layer);
    } else {
      layer.remove();
    }
  });
  // Kaart‑click/contextmenu → nieuw‑icoon menu (alleen wanneer niet aan het tekenen)
  let drawing=false;
  map.on('pm:drawstart',()=>drawing=true);
  map.on('pm:drawend', ()=>drawing=false);
  // Desktop: contextmenu (rechtermuisknop)
  map.on('contextmenu', e=>{
    if(shouldDebounce()) return;
    if(drawing) return;
    openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });

  // Mobiel: long press (600ms zonder beweging) → contextmenu
  let _lpTimer = null, _lpMoved = false, _lpLatLng = null, _lpXY = null;
  map.on('mousedown touchstart', e => {
    _lpMoved = false;
    _lpLatLng = e.latlng;
    _lpXY = { x: e.originalEvent?.touches?.[0]?.clientX ?? e.originalEvent?.clientX ?? 0,
               y: e.originalEvent?.touches?.[0]?.clientY ?? e.originalEvent?.clientY ?? 0 };
    clearTimeout(_lpTimer);
    _lpTimer = setTimeout(() => {
      if (!_lpMoved && !drawing && !shouldDebounce()) {
        openMapContextMenu(_lpLatLng, _lpXY.x, _lpXY.y);
      }
    }, 600);
  });
  map.on('mousemove touchmove', e => {
    // Als er >10px bewogen is, annuleer long press
    const t = e.originalEvent?.touches?.[0];
    const cx = t?.clientX ?? e.originalEvent?.clientX ?? 0;
    const cy = t?.clientY ?? e.originalEvent?.clientY ?? 0;
    if (_lpXY && (Math.abs(cx - _lpXY.x) > 10 || Math.abs(cy - _lpXY.y) > 10)) {
      _lpMoved = true; clearTimeout(_lpTimer);
    }
  });
  map.on('mouseup touchend', () => { clearTimeout(_lpTimer); });
}
// ======================= UI‑bindingen =======================
function updateHeaderHeightVar(){
  try{
    const h = document.querySelector('header')?.offsetHeight || 58;
    document.documentElement.style.setProperty('--header-h', h + 'px');
  }catch{}
}
function initUIBindings(){
  // Sidebar toggle + mobiel backdrop
  const backdrop = req('sidebar-backdrop');
  const sidebarEl = document.querySelector('.sidebar');
  try{ sidebarEl && sidebarEl.addEventListener('transitionend', () => { try{ map?.invalidateSize(); }catch{} }); }catch{}
  function setSidebar(open){
    document.body.classList.toggle('sidebar-collapsed', !open);
    document.body.classList.toggle('sidebar-open', !!open);
    if(backdrop){ if(open){ backdrop.style.display='block'; backdrop.removeAttribute('hidden'); } else { backdrop.style.display='none'; backdrop.setAttribute('hidden',''); } }
    // Leaflet invalidate
    setTimeout(()=>{ try{ map?.invalidateSize(); }catch{} }, 150);
  }
  window._setSidebar = setSidebar;
  on(req('toggle-sidebar'), 'click', ()=>{
    const willOpen = document.body.classList.contains('sidebar-collapsed');
    setSidebar(willOpen); // als dicht → open; als open → dicht
  });
  on(backdrop, 'click', ()=> setSidebar(false));
  // Init: op mobiel standaard dicht
  if (window.matchMedia('(max-width: 900px)').matches) setSidebar(false);

  // Filters
  on(req('apply-filters'), 'click', applyFilters);
  // Live update bij checkbox wijziging
  ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_val','f_poly_outline'].forEach(id => {
    const el = $(id); if(el) el.addEventListener('change', applyFilters);
  });
  on(req('reset-filters'), 'click', ()=>{
    ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_val']
      .forEach(id => { const el = $(id); if(el) el.checked = true; });
    const sl = $('f_period_slider'); if(sl){ sl.value='0'; updatePeriodLabel(0); }
    const fo = $('f_poly_outline'); if(fo) fo.checked = false;
    applyFilters();
  });
  // Slider: live label bijwerken bij schuiven
  const periodSlider = $('f_period_slider');
  if(periodSlider){
    periodSlider.addEventListener('input', ()=>{
      updatePeriodLabel(parseInt(periodSlider.value,10));
    });
  }
  // Cache reset
  // Beheer knop — altijd binden (knop is hidden maar bestaat in DOM)
  const _btnAdmin = document.getElementById('btn-admin');
  console.log('[app] btn-admin element gevonden:', _btnAdmin);
  if (_btnAdmin) {
    _btnAdmin.addEventListener('click', async () => {
      console.log('[app] Beheer knop geklikt');
      try {
        const { openAdminOverlay } = await import('./admin.js');
        await openAdminOverlay(_currentRole);
      } catch(e) {
        console.error('[app] admin overlay fout:', e);
        alert('Beheer kon niet worden geopend: ' + e.message);
      }
    });
  } else {
    console.warn('[app] btn-admin NIET GEVONDEN in DOM bij initUIBindings');
  }
  // ── Help overlay ─────────────────────────────────────────────────────────
  const helpOverlay = document.getElementById('help-overlay');
  const helpOpen = () => { if(helpOverlay) helpOverlay.classList.add('open'); };
  const helpClose = () => { if(helpOverlay) helpOverlay.classList.remove('open'); };
  document.getElementById('btn-help')?.addEventListener('click', helpOpen);
  document.getElementById('help-close')?.addEventListener('click', helpClose);
  document.getElementById('help-close-btn')?.addEventListener('click', helpClose);
  helpOverlay?.addEventListener('click', e => { if(e.target === helpOverlay) helpClose(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && helpOverlay?.classList.contains('open')) helpClose(); });
  // Tab wisselen
  helpOverlay?.querySelectorAll('.help-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      helpOverlay.querySelectorAll('.help-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('help-volunteer').style.display = btn.dataset.tab === 'volunteer' ? '' : 'none';
      document.getElementById('help-admin').style.display     = btn.dataset.tab === 'admin'     ? '' : 'none';
    });
  });

  on(req('btn-reset-cache'), 'click', async()=>{
    try{
      if('caches' in window){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); }
      if('serviceWorker' in navigator){ const regs=await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister())); }
      localStorage.clear(); alert('Cache & SW gereset. Herladen…'); location.reload(true);
    }catch{ alert('Reset mislukt'); }
  });
  updateSWStatus();
  updateHeaderHeightVar();
  window.addEventListener('resize', updateHeaderHeightVar, {passive:true});
  window.addEventListener('resize', _updateStatusbar, {passive:true});
  window.addEventListener('orientationchange', ()=>{ setTimeout(()=>{ updateHeaderHeightVar(); _updateStatusbar(); }, 250); }, {passive:true});
  setTimeout(()=>{ updateHeaderHeightVar(); try{ map?.invalidateSize(); }catch{} }, 200);
}
// ======================= Geocoder =======================
async function geocodePhoton(q){
  const r=await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`,
    {headers:{'Accept':'application/json'}});
  if(!r.ok) throw 0;
  const j=await r.json(); const f=j?.features?.[0]; if(!f) throw 0;
  return {lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0], provider:'photon'};
}
async function geocodeMapsCo(q,key){
  const apiPart = key ? '&api_key='+encodeURIComponent(key) : '';
  const r=await fetch('https://geocode.maps.co/search?q='+encodeURIComponent(q)+apiPart,
    {headers:{'Accept':'application/json'}});
  if(!r.ok) throw 0;
  const j=await r.json(); if(!Array.isArray(j)||j.length===0) throw 0;
  const b=j[0]; return {lat:parseFloat(b.lat), lon:parseFloat(b.lon), provider:'maps.co'};
}
async function searchPlaceNL(){
  const placeInput = $('place-input'); const q=placeInput?.value?.trim(); if(!q) return;
  setStatus(statusGeo,'Geocoder: zoeken…','warn');
  const geocoder = $('geocoder-select')?.value || 'auto';
  const key = $('mapsco-key')?.value?.trim() || '';
  try{
    let res;
    if(geocoder==='photon'){ res=await geocodePhoton(q); }
    else if(geocoder==='mapsco'){ res=await geocodeMapsCo(q,key); }
    else { try{ res=await geocodePhoton(q);}catch{ res=await geocodeMapsCo(q,key);} }
    map.setView([res.lat,res.lon], 13);
    setStatus(statusGeo,`Geocoder: ${res.provider} OK`,'ok');
    const searchOverlay = $('search-overlay');
    if(searchOverlay){ searchOverlay.classList.remove('active'); searchOverlay.setAttribute('aria-hidden','true'); }
  }catch{
    alert('Geen resultaat.');
    setStatus(statusGeo,'Geocoder: fout','err');
  }
}
// ======================= Iconen =======================
// Zoom drempels:
//   >= 15 : volledig icoon met emoji + tekst
//   13–14 : klein icoon, alleen emoji
//   11–12 : gekleurde stip met letter
//   <= 10 : kleine stip, geen tekst
// Periode-slider stappen (index 0 = alles, 1 = vandaag, 2..7 = steeds verder terug)
const PERIOD_STEPS = [
  { label: 'Alles',         days: null    },
  { label: 'Vandaag',       days: 'today' },
  { label: 'Deze week',     days: 7       },
  { label: '2 weken',       days: 14      },
  { label: '3 weken',       days: 21      },
  { label: 'Maand',         days: 30      },
  { label: 'Half jaar',     days: 183     },
  { label: 'Jaar',          days: 365     },
];
function getDateFrom(days){
  if(!days) return null;
  if(days === 'today') return new Date().toISOString().slice(0,10); // alleen vandaag
  const d = new Date(); d.setDate(d.getDate() - days);
  return d.toISOString().slice(0,10); // 'YYYY-MM-DD'
}

const ZOOM_FULL  = 15;  // volledig icoon + tekst (straatniveau)
const ZOOM_SMALL = 13;  // middelgroot icoon, alleen emoji
const ZOOM_DOT   = 12;  // stip met letter
const ZOOM_TINY  = 10;  // kleine stip zonder letter (< 10 = onzichtbaar)
// Labels en zichtlijnen/sectoren alleen op straatniveau
const ZOOM_LABELS = 15; // polygon labels tonen >= dit niveau
const ZOOM_LINES  = 15; // zichtlijnen + sectoren tonen >= dit niveau

// Icoon afbeeldingen — base64 PNG gebaseerd op gebruikersiconen
const IMG = {
  hoornaar_full:  '<img src="data:image/png;base64,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" width="30" height="36" style="display:inline-block;vertical-align:middle">',
  hoornaar_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAWCAYAAADNX8xBAAAE7UlEQVR42m2Ua2wUVRTH/3Nnd2en+6bdbp+0S0voCygPm1I1xVJoFVKwumtiYquf1BCMETRAJMNCDMQoYCsmmvDSGEw3IUQUBERaqLSxYKu25WEp9EW7fWxf2+3OzM5cP7RbS+B+ujfnnN/NOed/DoPZQwHmkGtJjgyaKak0bCDRF7Z7G6cFgHgAFQADgO7ZklGoZRDPEqVvYIr+Uf1Lh4hZ4xPno+KUzBBV81iWnjt8qdcvCCDZ7S7mytCfmzg9Hek3dTZ4vVCeFosaF9i/D0StisBduXF296rYLa4sGAHAnZeY78pPSo/4N+8zZJ+oTNFH3gQABAHE7YVqsoqmB6c0+QDgbRkYsZlMZUHToh+LVqTUaDj+0/DUSAgA7n3NpRmt8uI3U7skQZhhEADweKBSAYzzXaWW0THptFW/EAAvEs6ZsHiFzexIyaRR1h7/hE5DKQzcAmV9c5x0DntBPR6oj9WI0pn7SAMSxE5S0dqsVglnDGtEnYUnLDs6PdTT0T5km+4+Of4GZ1ZbHOWopxSEYWZAJAJiGFCvGySmAH3Hj+ke/lBnXK3TcCZneuap+IWLKwxak7x+Oe/86oQRjnLUC8L/kMdAANCWBQoAe66GTqssH7MoVpsYUNgBCZq6jHijQSOLWQfrJr58WrM0c6nVgGXcUK7vZIt/bdMFEhS5ODgtNTT5hj7WE3KzlPdrgjxblrUh5m5x1kTcix7p55oasG73jAwIpWAikK7v2WKbnVl+t0snhhW5pL4vPJSVnn6hwG73nekWR3kNcgI+JS3OEbb3nyRutxsKFUCoMC+z3hPa3NaDuj0AcLjEdvTbcpMXcBgybIacmaaYFxwtNe2rLjVfAYDbBzTbu4+zJXM1bvnEkMPxqhNaVcrcJl7cUWBOWxZNO1gS3uoLKX3tStxnk5Py2FpN/25Jz0fFWHRnewJ0w85LE5fvVHFFHFSHJGo6yfAoyOi49vfMbeJFALBCOsLpVNrrCzdmZ5CtrhI5/dVnghnrljBl8mi4V5LFIb0sVQHQZLwn/tbXI/8UCJBpzNfRrjzDC99t4umxcnODAzBAm1tRVFiiWJ3Lds266b/ZZKw5+5qZvr+Ce2f+pDIRidd6CsnGtU0NSxdqV94fZ488y/kDgWy+8sGYNYl2jl4rMIS6mx5AP24z3E+O0e2+3TPt6x61Lq1qGRj2ukAIakE8HqjPPX/zFauVX82aokhOcmjCN4m7j6aYSXBTSk6q/EgfhXvDErmxMkn0hQgZt0abHHEOZSsD0LZBMKQ9dkaENktUhSnaBplVL6bEBidMhOjTZNlh8SuK7KOOoB9rzAyNdyaqJMaK6pDWrOgM/FuVKdB76hAmXi+UykLojXb7S8My15ie5N+parl/Wgc0Nzg5HEy2BIctetUwGELsoERu+jRRTWucI2dE8J54u3lhwpL41LkR4QJQVK1x77VH8aW2BWqiqLBtb9+S7vj70WzpR/JgN3K7xmD9K6hcztkcaOqTtMt2nG7dPxbWbouOThh+Yl7oeZjvVetfjyy6z/OR2LiRGawtAj20Chsifv8eYjc/rIJzfiwBACqAnP8inevs0JeJY7geMW5vRN/tcfblLolUfHALl2pcYCkFExhX6jCtXVf/YbRpbjzo7E66KlhSW/ZzRRHwfBsACPM+BYBmgc9r3GXMimzY/wAF5RKYIodq4QAAAABJRU5ErkJggg==" width="18" height="22" style="display:inline-block;vertical-align:middle">',
  nest_full:  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAALQElEQVR42pVYbais11V+1lp7v+87M2fOTW705qMlKVYFr/6I+ENE4q2K0Aa0qXSs5eamksQEYqlVoYb2x2SwCI2iUvELkmCLsTWnTbH9EWii5hhoVawUGg4N2jSmvWlDkmvO1/ux915r+WNmzj339kZwwzDvDO/H8z7r2c9+1iYAcsstt9y4ubn5OgAQkZRSqOs6ARBCCJ2IODOLiJScMwGYqGoLAKPRiLqu88uPp9MpXnvttappGp1MJlpKIXdXIhIzC8MwZHcPIYQ8Go3swoULVz/zzDP/Tbfeeut1pZQ3xRj31oDW3zlnqapq4CUadnc1M8o5j0WkA4AYI+Wc/fJjAFDVWFWVhhDMzMjdUymFAUjOuRCRNE1Tcs4+DMOJuq6/Hfq+dwBe17UPwwARMTMjInIASCmV8+fPXzghJwI2UEopVEqZEFELAGZGzOwAMB6PqW3bI0BmVlVVpaUUBYBTp06dKKUwESHnDBHxnLPnnL2U4u7uIcbIqsqlFBYRiAgTEbm7tG1rGxsnRzfffPOfg/AWNQe5EwABoPjeQQCOALk7g8iYyc3xXwd7ex/NOau7N+4OZkZKSUIIxsycUuJARIWICjOXVanY3ZmI4H2Pkzdu/lmswrdM9Y+cirCLuTutmHR3lzWbzOyqCiKiYywxE1sI8q4TJ058fHd3997pdDow85GGUkpORGU6nZZgZioiVte1AsAwDNAQUA4PD6+54YafAtlNjzz88M9dgQ3cfffd726a5j0ppUJEklJ6sK7pBx566JOfusLpj91+++3fPnny5I+2bfsfVVU1XdcZAKvr2tq2NXfXoKoEgHLOvBamDQOXJVsjB+3O53MGnuaTF0bSDDfaS9df7zs7O+7u/wj0XzFbPjHGgwtTrr95HMVsNhMAeOyxx+zcuXO7IjJWVco5cwghxhiLqlIIgXLOFPq+nzRNM04plRXtXEqRlBJUtYK7LBYLA2AAytHrzmbynocfvuDAhcupePz3b7tG2nzfQV++fPYPt57y+ZyJyM+dOyeqWqWUJgAaVa1UlVXVSiljVd0Ik8nkgJkP67o+BAAR4WEYRFVbjtyvhIpP3H/bNacafzdF2X77Rx7/+q9sbX2PqB/76OxN49T9Wrc/vC1lfOn1Q3/ur+75ifjAagK4O4ioH41GByEELaWkpmkGVbW2bcN0Ot0Pq6l6XIRkZgQAXJgEzgBg6eDm8ebkL7s04PEPv/1lA/2nOb1czEpTSUeOHznB5Sdf6cvzr/X6zvs+/uSzF6F+5UoShKry+nkh+LJkr776Ktd1zSvDAgBemR+rKAykAHDhWwdfOtzLP95EvIUruZaDjBtCi6K0P+APFPTU4UH3fha5YSPQhx797V8AiL4TonzzoE9fvOtP/uF5ACQi5O7BzEJVVcg5s6rCjLmUgcOVkPvSa+DFyX1pK7+z9S8dgK+uPgCAX7xr9oM3jfiDjec+G07vdvnF517a+4svf3H76w++78x1mxvxzRuOt2qy0fqaUgpKKQbAVBUxRqwtAwBCVVUVgFBKiWsNubtU7tHZg9NFoPMzZwLedoofWGzl37zvXb/HKB+pKKBPBiJ837XT6oc3btr8wOn3veN3P/SJJx4E8F0A/370ogQDEFQ1MnM0M3Z3CiF4SinmnKsAoBCRrxECgIqwL3V0XLj0wNPbSoTy6j23/c0ohrNt21vXZXO3wMyu7gqQNLV87K473nH9w5984rfms9MVTu+UxQIGB5zZ1hqt69pLKRxCGMzMmDnz2qlDCDmEkEUkR/chiiR2tiN25nO69957wm/c884/nUzqswf7XVY1io2EZlSBiKjthnDY9XBF3hiPPnjXuVvvX2ztZGC+XleIzGw8Hvd1XQ+lFA8hJHfXGGMZj8fKpZSjhXQ9mNkHZodc/G+xWFhN//NDMcr793f3lZiiiFDJhiFlMDkmoxonNiYEh+wftG7u98/ns7jyMRgBOKZaIpIYo8UYyd1JVYmn0+mRiNdUmhmNRiO4+yVQ1dItQdgkBKgahqFAs4FBCCIwMxy2A4ZUmACvgoxffL79maP39IvWulohjp65zlDcdZ2vNRRCsFUYc1kueH5c1HC7e+gSuzmaOmLUBAgDZo6UC9SAWDE2pyNIEBPh6G53AsAMIFuy4msw7q7M7DlnJyJv29YZ/9fQ42ECMMMzwuylmJeiEGLEGMBEMAOIgMCClAv6LiENxb3gn4+kcNntRYSPswUAnFIam9loGIbxMAzjnPNIVUdDKWN1ry+5Q6GnDSC1QkUVQ0ooqoAAdSWoAiHlgv2DHrmYmIMM/q8AsAWYwVC8NKs81OSc65TSWFVHawxcVVXLzF1d122MsYsxdiLSZaJOiAasjHE+B+/r9Olc9NmmqsjdrZgtARmWmuoLTB0irJNx5TmXJ178Tve1ZVpYch0o9O4+uPsQYzysqqoVkU5VuxBCx6PR6BJxqSqhBjZkw1dTYUXPGX700Uf3hmR/LBzY1E2YMarisVIQVA05wVXBvdvHtre3y87OzvImRzElWozRjpXOY4wQEQ+7u7uxqqqqlBJzzhJCIBssHpZD37Sr4lpEi8W2zmYzCaPu00Mut0+a6mfVVQ8Oezl//lWMJw2uPXU1iqGEKKEb8kOnf+ynn5nNrpatY8lAVeuu6zaqqmoAIOcswzAoM1ellHGoqiqJSKqqKoUQaBU/ChF1xJyPz7HTp0/7YrFo77zzl25H8W8Qo9k9aG0/DVzIMdprSogxpFK++unPPvnr+OyTfJGXZfwQkaGqqsNVJxJjjAMzW9d1zVHJQgh0vGRrHxK5ZJJhsVjYbDaTRx75/Ev9gF+1jP6aqzf8zdddU77/5NVZQgxqfr7A7gBA8/kcl4R+IndxWvV4TERuZhRjpBACHflQzhnH8xAze9d1KOUSFwIAbG1t6ZkzZ8Jf/+0X/v71Nt2RB5JxPQ5NXUczfzn1+ee3tp762nw+p7VDH2tJfG2MZkYppQAAfd8DAPb395d6JCJPKTkzHy2yIuJE5leyp+3t7TI/cyb83Wee3Droyy+nUv6tH/IX0pDPbH3+n56bzWZyOZjj1lZKMVU1ETFmdhHxUoqLiIeU0rhpmiaEkFbNG7u7qKqZUQXCFUEttrfLfD7nxWLxOQCfu7gIgxeLLb1izgKIiKq1D6063ZGZWQihGYZhzLp8srm7uruqqqmqBVVjIoOD3sjI15pa6YWXYGBvbP1OAHRdCSIqq/ZcbTk0TCaToqrq7np8NvTuZbz8pfP5nI+85ApjNpvxzs4OgBlms+MZ4RLtGTlMViUjIvNlHNW6rq3rOm2aRkNKyaqqOm5UR7PMgX04bb6RHv6/g4gmCuzHGI2XlhJijFZKsVUnrGE6nWIYhksuDCFYjHF84ZVXnp2Ox989e+6OT5HbZ9yd3N3W+WnZcZMDehRhLh/MTO5ORPReVX3hcG/v2fF4PFLVXEq5RJ/T6RSh6zpfIfZVCLcYI3Vdx3VdY3d39+zmVVd9WEjuUnUHPLgjEJkReVF1AQxE5ESk7i4r71GAgllRWWalb+zt7X2AiKpVY2irPQUXEU8pedu2HkRkXEoZr6MTEckwDDAzEZGgquHFF15YiIi0bUt1XccQArt7f/l2zOWpc9WZalVVutrQOrG6J4gollLE3dcWMAIwCaWUBCABGGKMZGZUSmFmDjlnE5Fy8uTJTWbmyWQCM4u8HIGZfXXu2sP4eBnMLIqIxRi173sSkZxztqZpvO97ZeYQQlAismEYcgihD4eHh9jY2PAVK6jr2pnZh2HwUoqvEp6taEVVVZRSEmYuq7QnImJrM2VmTykdbcXEGNe2QuvNqXV7TkQ+DANWjPnBwQH+FwfsiwUvg5wvAAAAAElFTkSuQmCC" width="36" height="36" style="display:inline-block;vertical-align:middle">',
  nest_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAFKUlEQVR42l2VXYhdVxXH/2vttfe5Zz4yd5IUGlHIi0Hax/bB4oMfCWQIiCbiQ5mOPjkvkioq+CBlOuDXi+AHVkjFmBYEqzYVKabWovWlKFQhQrHB1toQdIiZ3smdc8+5Z++1lg9zb2n6f9qbzdp78Vtr/xedOXPmbgBVVVX9dDpN0+k0DAaDadd1XYyRm6YRZs51XRMAiIiPx2OYWVxcXCwhhCQi3DQNLSwsFDMTM+ul7/vlEELqui4zcyIiNTMZDofvNzMeDAYSQuhLKRARuDsdPnyY3F1ijGUymVxvmgZVVVUAcikllFKyuLu6u1ZVpW3b5kSpXj16ZDOJtH3fGx0oMvPA3Yu7ZcDNnSyIcEopjcfjx6bTaWZmdXe4u0pd18XdAzN7znl06MihjzLw5sWLF7+NmT6/uflAvbT0oUlz+82my3+5dOnSG/OzjY2NRxYWFj64u7v7m5TSSkpJY4xFuq6rQgiJiDTnnJ0ouvse3qEfXrjwEoCX5vsnv7J2ti1+7cbfuldfc99z9yqEUHVdNwghWCmFJISQmZlERJk5C4BJDvu//drJU4gLD+9P8x8cuD5g3F5ckHv/dzufmvb69JCGr2+++FzZWF8XImpTSr2I9Mzs7p4Z75K6WyW+0I/3/357kn9Fpm+VXhdvtPjGa7v68a4vzy6msNuH/Yee/tLJEwXcsTsBADP7/B5R1QggllLYzKK7cyCLn/j+n3cAXDrx4INHP3aoezw4PmDupaiMRuPRlzfuWdkZ7TMRuWQzb5pGqqoKpRRWVbC7q6qaqhoAGJE7ObmDvrj5qfvXhu21xcSfdC9LsDJcGoSzR5ZX/vTLf8mxz3zn+YbcxYkshOBmRmZmRFS4qiqNMWpd1yXG2DORkRMRwTPKdwPz6rjpegAITOi6Mo0i7xWffhMAiJw5QN29iIhVVVVijHYHY1UlYid3nnx189QKud+X++IMiloMZgCIkqo6DCe3PgwBuCMjruuamNnN7IC3mQkRhbZtJYQQvDgjaBgcW21z1k7NIIHBTHA4AsH7viDnMnn0Rai6B3enpmmk6zrJOYe2bYUBoO/7tytqZA7FYHv7F70Dz4gE6qa9hsCIByiMiAngnxHgRB4NhhijiYjNu4NV1d7ZJjMdFFLjt3Kv+1US3r2156O9xog5TNr83/2M7wGAqxsMmCMADtZ3MJ4/4EQGAD9+8plr6v6FwIF3x00e7Xees1Hp7aHLl5/7zyzG5vEHH5ecmZ1jjBZj1Kqq1MwUCOpQAoDz59eqx3/67E9Go8kj7zt2d1pZXg6Trv/sz3/9+xfOr61Vs+zciWyOIqWkdV0XLqXEUkoqpURVje5F5hlcvdrq1hb4iaee//rorcm5bjr9yFOXX3hia2uLr7atAoCzE8zCZDIRdxdVjX3fp3D8+PGjAISI0LZtWVpcuiemmM+dPffXyWQSbt681z99113hsd/98ZVX/vHGvzc374vLyyd8Z2dH1tfX/dbNW/c7OZr95p+DwSCpKquqi4j0ACilVJg5E9EUitXt7W0D0L/bSy5ceDkDLwPA9MqVK1hfX19V1Rsi0hNRNTO0nk6fPn2cmZOIZDMTVa2Hw8OfSynt9aVXcmIid3cnIvI5VwCIMUopZWk8Hv+olJJDCA7gYIKoajSzNKtqZWZlb2/nBykN31NQKjYjd87Md148H03j8fj6bBZWZlbMLKoqxN31wC1dZyikhyA3e6/nnBMzewghqyrVdY22bd92xtm0SAe+Q2VmZOru+n/Y207SPkFlnQAAAABJRU5ErkJggg==" width="22" height="22" style="display:inline-block;vertical-align:middle">',
  nest_geruimd_full:  '<img src="data:image/png;base64,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" width="28" height="36" style="display:inline-block;vertical-align:middle">',
  nest_geruimd_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAWCAYAAAAmaHdCAAAE5UlEQVR42l1UWWxUZRT+/v+/987cdkr31k6H1ZalQ+m000gFTBEkBqNFgyNr1Ig2Eh/whaAGvdaIRB80oj4UTcAgEdvIWkQMESpohS7IYl2ILQiF0pZC25m7zF2ODzBGOU/n5Mt3Tr6zMdxlpIEfQy1PxfO7C4g1N7upuPWlmiomOW9YDk4u+qRjc1MsJtg3aytnFahije3SnkEDp+q2dup3J66vj8qrVanKJ7xltkeTHQc7juZ27H3sWlQcKOp02d7nKlaNzxRfCIlhxPAsj+F3IuqxiekyZ64gNwtMzM7LUAr7R+0TlkPrT94wuxqau5OpIgwAXo2V5Ef9aoWqYJItMEFhTMhGcshRfdU2YyvH4kZdNrFBlqGWSoKXSUQ5nDGXSax/xHT2sfNlZYHgNVPk3OwZ+a+E9z54ca1sGyu5bURMm9rGksmmt9/Z99kdmG9bVzGutJ8eTjq4yPSqmRcEg9SbxhdMP362t/H1pbNNv2+H3ydKTcuB5biQOQByYep2l6rry1/ecuTCpWmVwWJf8hABQmzIz5+XpipzcxL2g5OXROyh3MDONEkqGtMt27Yd5jgu8zx4lu06Al5oVFGeeKEk1DNneGS7SFfKTcf9jgHASKS8cRyj+ptZCrZHi5AIqN44SeHEOZKWBcuywAEYgJftEX+6vQ95I0mMkLcl63T3OkYAZ4DXs+i+9slXRyuH8lTsqr1XJBQFiuPCZYAgQsJ1IcV1PNveZ98zZotLGUrLpBNnllAsJsSbAHI2Lq88V5a3wW9acknvTV48OMbOZstIcAYfEWxFhmJZWHXqCoIDOmufkcu/rA7Ja8qn76zYvlvnDCBb2KrfRdqhSBCd4QJWfMPAM2euI0sIGGk+CMPEivY+FA/oaCvJ5Aem5sNne1N6FD2bAcQAgIjYuxuX9kiymGQIeItP9/Ho+QFcG5+JPdEg6jqvInRlFJ3Tc7FvZqGrEvGxUb1r88dHqjUNnGtarcQYI+LisCQ4WDzp7Z+ej66ZhSga0lH//V8IDSXwSzgfB8KFUFyQJAmmqmrz7ZWp5RIw3wNaQZy/b3tUL3PGPUmio9PyWWn/GDLGLMTTZBwaH4BuWl5BepqIJ8zLGEp8SATGWKvLGxoaPE3T+GsNX/3p2d5uNSfAZdP0nmy7iIy4hcGAjEDcwerOfuRyQZbnMH04/nbD561mc3OMAyABAK3HWkHdMXEik30L5i5cffp6UejvW3QqV+FbpmahSJExrfeWXWp5vCMgPtq09eimjvqovOiVI86/B5jalV5M9AerMloU0MJfgwH6tFiFokhM8sneij+GefnlOOC6R9pcvmxOd/dwisdTzuHCWemF0ayDiiQtHFCltv3VITsULGA56enJTEXiu2bkn9TJ24UM/0OVCms5PqE8mwFeEyA4A7yfQjXqA0HaoypiQdyy9xf++Pg8ePx5z0qaVtJU9LjVYblyXfqZ31YkjGSTP025vzoPLR1ToplPAS62Taz1G5XlB2lulPRIeLeGWonotsyN6x6Z8db6xY/GYjEFACgWEzFA6JGyr2luFZlVM1s7otFMGJHyk1RTSUZFuLkRUZkARgDXNI3/7/cS2B2MaaiVjIpwM9VEyIiEz8GIhH9OVISPNSIqsztNThE1TeOaViulBpAaAgGsEVHZiIRbExXhH/4BTRw+aPkvjewAAAAASUVORK5CYII=" width="17" height="22" style="display:inline-block;vertical-align:middle">',
  lokpot_full:  '<img src="data:image/png;base64,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" width="24" height="36" style="display:inline-block;vertical-align:middle">',
  lokpot_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAWCAYAAADwza0nAAADWklEQVR42l2ST2+UdRDHPzPP83R327placG2EFtDa8UNVVMVolGpBxJQSEDXmBLDDb2Z+AYaX4UWLh44ERqtJibEGOzZJkQIIhSipbSgoYVt6bK7z/Ob8VDAppNM5k++k5n5zsAmqUAEcKDcNnqg3Da6MbdRdGMwDlpaz0nkmUSOAFICHd+EjTcGX4GxrqijkAH4KUg3d5Qnzok+8g+2JC/mMk9aotzcnbr1eYxsV51L1fqDS3Z/pXZleo46QDQOOg0M9CdDanI4TrSaqowU4jDWHvteA1S96W77W1uj21fvhvsOIhs6e+Xlwo5coqXVR81yJOEj3N08/q6lJb5RFxZ+uPho8QlWARyYmTiZnLtcX1hqIDt3dC3vHi5PDL1aPt37XNf8mumjH3+vL05MjCSP4f/v+JTZE+/mP62UpyytveVmNIKc31P5tiIitpkcuXBhPBqi/kkU8UESJSMhbQ40Gms4jjs4MovIb83Upi7W9k9WKh9bfPbsWR0IM5M9vR1HkIh6rc5ybQUHB0HEJZ/oYEsSD7YkMtZcOD8JXpE/pr441t3VPpmmIbWQSjBXs6Duhrvg7ribuWEIrmrJ7Ttrx2Lf/vbltt3lex6lnZ4VEL8vkIE77gJmEDL1EAQci4pL1c6bV6SZ+edJxNePP0bhIU8fyB0sQJat27RuFLs1pe2zWOrzx2mcw4qONhpQ+xdUILMnzENqUHcsGLrajT9zfCyWpek9/P0l+pqKzxs3z4NF67Xi0EihtQD9faDp+vmiVwb2xFFY6UBiPLQK3mB2zvj5VyeXrE+amVA5KvQPGo6KNANR9mBrbJKk6llC7SHUjH37hDQTfrlg5PNw7H1luOyQOYiCGiZJM7b8rr9UcoNyq+m+hpa2OcPDUMiLt8Tw0m73QqurG4i7USiItw1c01B67wxd7wj3PIgnWIAb17HlZbKFRcLsdQwFNIG6G92jkpVGz4i7F8Odn2ai+bFBW6pm6mhtRqV6V0QNtmx3cm+aWQPTzq1xtuvMnw96Dr6hIrKS9Rw6bM+fvqS9e2OyRFvdpKcYeLYjkAsGjVi19/XYXjh1KfQcPLJNZFXcXUXE/nFv7wzLJ7l17ihzV4f8YbUEIMWOKjsGrtnOD7+v5rq/2Say6u76H89esJm+cjJyAAAAAElFTkSuQmCC" width="14" height="22" style="display:inline-block;vertical-align:middle">',
  val_full:  '<img src="data:image/png;base64,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" width="36" height="36" style="display:inline-block;vertical-align:middle">',
  val_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAFnklEQVR42kWUS4hceRXGv/N/3P+9tx6d7kpXm0ynTYdkSII6QlxpZpAJOos0MZsSREHDgCBkMS4yuBtqIbjIzgfovEBcWYsZhVm4ESUI2UgMODhGE9q0k/Qr9quqbtX9/885LqZbz/YcPvg+zveja9eutZjZTadTUVWXUiLnnO7u7u7HGDMA8N7rcDi01lotikKazaYBkFZXV3H27NmG9z4+exb96dNzaWdnB3meR7p8+fK8tdYyM4uI994LM3Oz2VxUjTngoKqcKCWnjlTVeU8WUE6J0sHBwVpZljwajfKyLFNVVWqtjc5aGwEoADbGwDknx441v2MMVSJmrKoE2KCczonEyrjyMZFEVSN5bsoQ7Jf398dvq2pyzsVWq4XpdBqd915jjAghmKdPn1ZLSyc/r6ry3nsf/AyH0+t97bNGi88MR8OP8rx8fzAYbB3trl+/erMoivPr6/HDZpOz6XQqIkJuMplk1lqrquq9Z2OMN8Zu9Xo9C8DOPnqkP//1+3/90vONt5zz9IWvv/bs0qVL/syZMwSA67rayzKTWSs+hOC997y7u0uGmclaawEgxmgAQJXdYDBgAHxiZYWISL9x87UffPWb3/5+v9+XlZUVAsCDwYCJ1IiIAPsYjUao69oAgGk0GtOqqmJR1LVzbipiImABABcvwvb7/frNN3/4ufmF7tVWq3X19ddfvdDv92scHQEgQnLOTUMIdV3XdQihNiKSO+dsXReeiLxzsMYoAUC/P6jfeedHr3xqofPHRlk0i6Kc63Rm77zxxs2XB4NBfSSs6pxqO0sp+Waz6ZjZGwBgZqrr2hRFYZjZEpEBgNu3b133nj4A4dj+wYGmFNV723GOfnfr1o2VT0TVAclmWWW994aZKYRgnDFm4r33zjkdDodMhGSMIQA49+llX7Qa9sn6erW9seFjTOLzMi7MLzQWuycDAFhrIaKprmv23qOqKiWi5EIIJsaIPM8lxpiMsUJEBAAnTiycm5lb1OE4q6ZjSTB2HLKGttp5WTg5DwDGGLLWCjNH55xpNpu8u7vLxjmns7OzGmOkhYUFiBgjIgCAUYXLavZoufzzzMN7fzj4173fYzm/twDdpr0qXQYAEVFVofn5+aPI0e124TY3NzMict572drawtLSkhcZJyDDhdYvl4+fegI7uU+3H4Rny8fjnZdOTr5XNxt4/PGLpwEP8ISZrd/YGAfvfSCitLGxYZy1VrMs40PAsLXKXDMBDo29Bw376CM8vutMO6a/YEeerN03dOq5EY6PVxuAg4goYBFCzSLCzCzOOTWdTicSUcqyLMY4l4wx0TprgBpR57YxVP3H31K19Fzzpe5s/sV/PtQKBjql9jZQwxKstSZ2u93Y6XTi4uJiba2NZnNzM6uqKgyHw5DSxyGlFJzzDkigmfO/nTwuiCqkVgbfadCMDCFpL1Caef43AMP4zDKLX1vbzdfX18Pm5mY+Ho+DK4qCjDGIMaLdbgMAWF0EgKen3vpxe/XDV19+5e7ihftbAUD3xFm4tfjC2t/P/vQnwK8Q2TDAaLWAsiwRY6R2uw13yB/8v56kzFr3ej17cZF27t/5Ra8xzN5tnX96BgLeLroP/j3zrRtfuTiz0+v1bF2P4uE/a4zRWGtZROCIKDEzAeAYI4uIqPLcIYTwwovfvQuEC6qTJgBtURgBfwIADAYDXLu2Mkukjw7FIwCklJiuXLnSUVVX17UQkcvznMsyu2GtnYjwgTFwzFOZjGOCMVwEmxsTSIBERDMpaaZKb08m/8mIGslaq1VVRXcUQQhB6rrGcDjEcNh8d3bWL4tIDiQ452C9MUSkk5oUYDgHjlF5f3//4Sf2gXbbalVVCuB/GauIwHsvxhiTZZDRaHQ/xuhTSnQEKmutOuf0sHEJAMqybBORSSlJjFGccyAi/S+2DQmcVNVWUgAAAABJRU5ErkJggg==" width="22" height="22" style="display:inline-block;vertical-align:middle">',
};

function makeDivIcon(imgHtml, _bg, _border, size){
  // Geen achtergrondvlakje — alleen het icoon met drop-shadow voor zichtbaarheid
  size = size || 'full';
  if(size === 'full'){
    return L.divIcon({
      className:'custom-div-icon',
      html:'<div style="background:none;border:none;padding:0;display:flex;align-items:center;justify-content:center;gap:3px">'+imgHtml+'</div>',
      iconSize:[40,40], iconAnchor:[20,20]
    });
  } else {
    return L.divIcon({
      className:'custom-div-icon',
      html:'<div style="background:none;border:none;padding:0;display:flex;align-items:center;justify-content:center">'+imgHtml+'</div>',
      iconSize:[26,26], iconAnchor:[13,13]
    });
  }
}
function makeDotIcon(color, letter, size){
  letter = letter || '';
  size   = size   || 12;
  const border = size <= 6 ? 1 : size <= 9 ? 1.5 : 2;
  const fs     = Math.max(6, Math.round(size * 0.55));
  const total  = size + border * 2;
  return L.divIcon({
    className: 'dot-icon',
    html: '<div style="width:' + size + 'px;height:' + size + 'px;background:' + color +
          ';border:' + border + 'px solid rgba(255,255,255,.8);border-radius:50%;' +
          'display:flex;align-items:center;justify-content:center;' +
          'font-size:' + fs + 'px;font-weight:700;color:#fff;' +
          'box-shadow:0 1px 3px rgba(0,0,0,.6);line-height:1">' + letter + '</div>',
    iconSize:   [total, total],
    iconAnchor: [total / 2, total / 2]
  });
}
const ICONS = {
  hoornaar:(a,sz='full')=>makeDivIcon(
    sz==='full'
      ? IMG.hoornaar_full + (a ? '<span style="font-size:10px;font-weight:900;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000;line-height:1">\xD7'+a+'</span>' : '')
      : IMG.hoornaar_small,
    '','',sz),
  nest:(sz='full')=>makeDivIcon(
    sz==='full' ? IMG.nest_full          : IMG.nest_small,
    '','',sz),
  nest_geruimd:(sz='full')=>makeDivIcon(
    sz==='full' ? IMG.nest_geruimd_full  : IMG.nest_geruimd_small,
    '','',sz),
  lokpot:(sz='full')=>makeDivIcon(
    sz==='full' ? IMG.lokpot_full        : IMG.lokpot_small,
    '','',sz),
  val:(sz='full')=>makeDivIcon(
    sz==='full' ? IMG.val_full          : IMG.val_small,
    '','',sz),
  pending:(sz='full')=>makeDivIcon(sz==='full'?'\u23F3':'\u23F3','','',sz),
};
// Stip-iconen: kleur + één letter als herkenbaarheid
const DOTS = {
  hoornaar: (sz)=>makeDotIcon('#cc2222', (sz===true||sz==='micro')?'':'W', sz==='micro'?5:sz===true?8:13),
  nest:     (sz)=>makeDotIcon('#334466', (sz===true||sz==='micro')?'':'N', sz==='micro'?5:sz===true?8:13),
  nest_geruimd:(sz)=>makeDotIcon('#1a7a40',(sz===true||sz==='micro')?'':'G', sz==='micro'?5:sz===true?8:13),
  lokpot:   (sz)=>makeDotIcon('#2d6b50', (sz===true||sz==='micro')?'':'L', sz==='micro'?5:sz===true?8:13),
  val:      (sz)=>makeDotIcon('#8b6030', (sz===true||sz==='micro')?'':'V', sz==='micro'?5:sz===true?8:13),
  pending:  (sz)=>makeDotIcon('#888888', (sz===true||sz==='micro')?'':'?', sz==='micro'?5:sz===true?8:13),
};

// Geeft juist icoon terug op basis van huidig zoomniveau
function getIconForMarker(meta){
  const zoom = map?.getZoom() || 14;
  const type = meta?.type || 'pending';
  if(zoom >= ZOOM_FULL){
    // Volledig icoon met emoji + label
    if(type==='hoornaar') return ICONS.hoornaar(meta.aantal,'full');
    return ICONS[type]?.('full') || ICONS.pending('full');
  } else if(zoom >= ZOOM_SMALL){
    // Klein icoon: alleen emoji
    if(type==='hoornaar') return ICONS.hoornaar(meta.aantal,'small');
    return ICONS[type]?.('small') || ICONS.pending('small');
  } else if(zoom >= ZOOM_DOT){
    // Stip met letter (size 13)
    return (DOTS[type]||DOTS.pending)(false);
  } else if(zoom >= ZOOM_TINY){
    // Kleine stip zonder letter (size 8)
    return (DOTS[type]||DOTS.pending)(true);
  } else {
    // Onder ZOOM_TINY: nog kleinere stip (size 5)
    return (DOTS[type]||DOTS.pending)('micro');
  }
}
// Alle markers bijwerken bij zoom
function refreshAllMarkerIcons(){
  allMarkers.forEach(m => {
    if(markersGroup.hasLayer(m)) m.setIcon(getIconForMarker(m._meta||{}));
  });
}
// Labels en lijnen tonen/verbergen op basis van zoom
function refreshZoomVisibility(){
  const zoom = map?.getZoom() || 14;
  const showLabels = zoom >= ZOOM_LABELS;
  const showLines  = zoom >= ZOOM_LINES;

  // Polygon labels — via Leaflet add/remove (betrouwbaarder dan display:none op tooltip)
  polygonsGroup.getLayers().forEach(layer => {
    if(!layer._labelTooltip) return;
    const onMap = map.hasLayer(layer._labelTooltip);
    if(showLabels && !onMap) layer._labelTooltip.addTo(map);
    else if(!showLabels && onMap) map.removeLayer(layer._labelTooltip);
  });

  // Zichtlijnen: opacity via setStyle
  linesGroup.getLayers().forEach(l => {
    l.setStyle({ opacity: showLines ? 1 : 0 });
    if(l._distLabel){
      const dle = l._distLabel.getElement?.();
      if(dle) dle.style.visibility = showLines ? '' : 'hidden';
    }
    if(l._handle){
      const he = l._handle.getElement?.();
      if(he) he.style.visibility = showLines ? '' : 'hidden';
    }
  });
  // Sectoren
  circlesGroup.getLayers().forEach(s => {
    s.setStyle({ opacity: showLines ? 1 : 0, fillOpacity: showLines ? 0.25 : 0 });
  });
}
// ======================= Contextmenu infra =======================
let contextMenuEl=null;
function closeContextMenu(){
  if(contextMenuEl){
    contextMenuEl.remove(); contextMenuEl=null;
    document.removeEventListener('keydown', escClose);
    document.removeEventListener('click', closeContextMenuOnce, true);
  }
}
function positionMenu(el, x, y){
  const isMobile = window.innerWidth <= 600;
  if (isMobile) {
    // Op mobiel: menu breed, gecentreerd onderin
    el.style.left     = '50%';
    el.style.transform= 'translateX(-50%)';
    el.style.bottom   = '12px';
    el.style.top      = 'auto';
    el.style.maxWidth = (window.innerWidth - 24) + 'px';
    el.style.width    = 'max-content';
  } else {
    const pad = 6, vw = window.innerWidth, vh = window.innerHeight;
    el.style.transform = '';
    el.style.bottom    = 'auto';
    el.style.left = Math.min(vw - el.offsetWidth  - pad, Math.max(pad, x)) + 'px';
    el.style.top  = Math.min(vh - el.offsetHeight - pad, Math.max(pad, y)) + 'px';
  }
}
function escClose(e){ if(e.key==='Escape') closeContextMenu(); }
function closeContextMenuOnce(){ closeContextMenu(); }
function openMapContextMenu(latlng, x, y){
  if(!canWrite()) return;  // volunteer mag iconen plaatsen, pending/andere niet
  closeContextMenu();
  const el=document.createElement('div');
  el.className='ctx-menu';
  el.innerHTML=`<h4>Nieuw icoon</h4>
  <button data-act="mk" data-type="hoornaar">Waarneming</button>
  <button data-act="mk" data-type="nest">Nest gevonden</button>
  <button data-act="mk" data-type="nest_geruimd">Nest geruimd</button>
  <button data-act="mk" data-type="lokpot">Lokpot</button>
  <button data-act="mk" data-type="val">Val geplaatst</button>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return;
    closeContextMenu();
    openPropModal({
      type:b.dataset.type,
      init:{ _latlng: latlng },
      onSave:(vals)=>{
        const m = createMarkerWithPropsAt(latlng, b.dataset.type, vals);
        persistMarker(m);
        _logAction(b.dataset.type, vals, m);
      }
    });
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y);
  document.addEventListener('keydown',escClose);
  document.addEventListener('click',closeContextMenuOnce,true);
}
function openMarkerContextMenu(marker, x, y){
  closeContextMenu(); const isLokpot=(marker._meta||{}).type==='lokpot';
  const el=document.createElement('div'); el.className='ctx-menu';
  el.innerHTML=`<h4>Icoon</h4>
  ${canWrite()?'<button data-act="move">✋ Verplaatsen</button>':''}
  <button data-act="edit">✏️ Eigenschappen</button>
  ${isLokpot?'<button data-act="new_line">📐 Zichtlijn toevoegen</button>':''}
  ${canWrite()?'<button data-act="delete">🗑️ Verwijderen</button>':''}`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    setTimeout(()=>{
      if(act==='move'){
        marker.options.draggable = true;
        marker.dragging?.enable();
        marker.once('dragend', () => {
          marker.options.draggable = false;
          marker.dragging?.disable();
          persistMarker(marker);
          if(marker._meta?.type==='lokpot' && marker._meta?.potId){
            const ll = marker.getLatLng();
            movePotLines(marker._meta.potId, ll);
            allLines.forEach(l=>{
              if(l._meta?.potId===marker._meta.potId){
                l._meta.pot={lat:ll.lat,lng:ll.lng,id:marker._meta.potId};
                persistLine(l);
              }
            });
          }
        });
      } else if(act==='edit'){
        openPropModal({ type: marker._meta.type, init: {...marker._meta, _latlng: marker.getLatLng()}, onSave:(vals)=>{ applyPropsToMarker(marker, vals); persistMarker(marker); }});
      } else if(act==='new_line'){
        startSightLine(marker);
      } else if(act==='delete'){
        deleteMarkerAndAssociations(marker);
        if(marker._meta?.id){ deleteMarkerFromCloud(marker._meta.id); }
      }
    },0);
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y);
  document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}
function openLineContextMenu(line, x, y){
  closeContextMenu();
  const note = line._meta?.note || '';
  const el=document.createElement('div'); el.className='ctx-menu';
  el.innerHTML=`<h4>Zichtlijn</h4>
  <button data-act="color">🎨 Kleur</button>
  <button data-act="note">📝 Opmerking</button>
  <button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    if(act==='delete'){ deleteSightLine(line,true); }
    else if(act==='color'){ openColorModal(line._meta?.color||'#ffcc00', col=>{ setSightLineColor(line,col,true); }); }
    else if(act==='note'){ openLineNoteModal(line); }
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y);
  document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}
function openLineNoteModal(line){
  const modal = document.getElementById('line-note-modal');
  const inp   = document.getElementById('lnm-note');
  const save  = document.getElementById('lnm-save');
  const cancel= document.getElementById('lnm-cancel');
  if(!modal) return;
  if(inp) inp.value = line._meta?.note || '';
  modal.classList.remove('hidden');
  function cleanup(){ if(save) save.onclick=null; if(cancel) cancel.onclick=null; modal.classList.add('hidden'); }
  if(cancel) cancel.onclick = ()=>cleanup();
  if(save) save.onclick = ()=>{
    line._meta = line._meta || {};
    line._meta.note = inp?.value?.trim() || '';
    persistLine(line);
    cleanup();
  };
}
// ======================= Modal (icon properties) =======================
// prop-modal elementen worden in openPropModal opgezocht
function openPropModal({type, init={}, onSave, readOnly=false}){
  const modalEl2 = document.getElementById('prop-modal');
  if(!modalEl2){ console.warn('[UI] prop-modal ontbreekt'); return; }
  const pmDate2   = document.getElementById('pm-date');
  const pmBy2     = document.getElementById('pm-by');
  const pmAmount2 = document.getElementById('pm-amount');
  const pmSave2   = document.getElementById('pm-save');
  const pmCancel2 = document.getElementById('pm-cancel');
  const pmTitle   = document.getElementById('pm-title');
  const pmColorRow= document.getElementById('pm-color-row');
  // Titel
  const titles = { hoornaar:'Waarneming', nest:'Nest gevonden', nest_geruimd:'Nest geruimd', lokpot:'Lokpot', val:'Val geplaatst' };
  if(pmTitle) pmTitle.textContent = titles[type] || 'Icoon eigenschappen';
  // Velden vullen
  const pmNote2 = document.getElementById('pm-note');
  if(pmDate2) pmDate2.value = init.date || nowISODate();
  if(pmBy2) pmBy2.value = init.by || _currentDisplayName || '';
  if(pmNote2) pmNote2.value = init.note || '';
  const onlyH = document.querySelector('.only-hoornaar');
  if(onlyH) onlyH.style.display = (type==='hoornaar' ? 'grid' : 'none');
  if(type==='hoornaar' && pmAmount2) pmAmount2.value = (init.aantal!=null ? init.aantal : '');
  // Zenderactie — alleen bij lokpot
  const pmSenderRow = document.getElementById('pm-sender-row');
  if(pmSenderRow) pmSenderRow.style.display = (type==='lokpot' ? 'block' : 'none');
  if(type==='lokpot'){
    const senderVal = init.sender || 'nee';
    const jaEl = document.getElementById('pm-sender-ja');
    const neeEl = document.getElementById('pm-sender-nee');
    if(jaEl) jaEl.checked = (senderVal === 'ja');
    if(neeEl) neeEl.checked = (senderVal !== 'ja');
  }
  // Nesttype — alleen bij nest
  const pmNesttypeRow = document.getElementById('pm-nesttype-row');
  if(pmNesttypeRow) pmNesttypeRow.style.display = (type==='nest' ? 'block' : 'none');
  if(type==='nest'){
    const pmNesttype = document.getElementById('pm-nesttype');
    if(pmNesttype) pmNesttype.value = init.nesttype || '';
  }
  // Ruiming — alleen bij nest_geruimd
  const pmRuimingRow = document.getElementById('pm-ruiming-row');
  if(pmRuimingRow) pmRuimingRow.style.display = (type==='nest_geruimd' ? 'block' : 'none');
  if(type==='nest_geruimd'){
    const pmRuimer  = document.getElementById('pm-ruimer');
    const pmMethode = document.getElementById('pm-methode');
    const pmSuccesJa = document.getElementById('pm-succes-ja');
    const pmSuccesNee= document.getElementById('pm-succes-nee');
    if(pmRuimer)   pmRuimer.value   = init.ruimer  || '';
    if(pmMethode)  pmMethode.value  = init.methode || '';
    if(pmSuccesJa)  pmSuccesJa.checked  = (init.succes === 'ja');
    if(pmSuccesNee) pmSuccesNee.checked = (init.succes !== 'ja');
  }
  // Val-specifiek — alleen bij val
  const pmValRow = document.getElementById('pm-val-row');
  if(pmValRow) pmValRow.style.display = (type==='val' ? 'block' : 'none');
  if(type==='val'){
    const pmValtype      = document.getElementById('pm-valtype');
    const pmKoninginnen  = document.getElementById('pm-koninginnen');
    if(pmValtype)     pmValtype.value     = init.valtype     || '';
    if(pmKoninginnen) pmKoninginnen.value = init.koninginnen != null ? init.koninginnen : '';
  }
  // Kleur verbergen (is voor polygonen, niet iconen)
  if(pmColorRow) pmColorRow.classList.add('hidden');

  // ── Broninfo sectie (GBIF / waarneming.nl) ───────────────────────────────
  const srcBlock = document.getElementById('pm-source-block');
  const srcRows  = document.getElementById('pm-source-rows');
  if (srcBlock && srcRows) {
    const src = init.source || '';
    if (src === 'GBIF' || src === 'waarneming.nl') {
      srcRows.innerHTML = '';
      function srcRow(label, val, link) {
        if (!val && !link) return;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:baseline';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'color:#94a3b8;min-width:110px;flex-shrink:0';
        lbl.textContent = label;
        const val2 = document.createElement('span');
        val2.style.cssText = 'color:#334155;word-break:break-word';
        if (link) {
          const a = document.createElement('a');
          a.href = link; a.target = '_blank';
          a.style.cssText = 'color:#0aa879;text-decoration:none';
          a.textContent = val || link;
          val2.appendChild(a);
        } else {
          val2.textContent = val;
        }
        row.appendChild(lbl); row.appendChild(val2);
        srcRows.appendChild(row);
      }
      const LIFE = { 'ADULT':'Volwassen', 'JUVENILE':'Juveniel', 'LARVA':'Larve', 'PUPA':'Pop', 'EGG':'Ei', 'UNKNOWN':'' };
      const SEX  = { 'FEMALE':'Vrouwtje', 'MALE':'Mannetje', 'HERMAPHRODITE':'Hermafrodiet', 'UNKNOWN':'' };
      const BASIS= { 'HUMAN_OBSERVATION':'Menselijke observatie', 'MACHINE_OBSERVATION':'Sensor/camera', 'PRESERVED_SPECIMEN':'Specimen', 'LITERATURE':'Literatuur', 'MATERIAL_CITATION':'Materiaalcitaat', 'OCCURRENCE':'' };

      srcRow('Bron', src);
      if (src === 'GBIF') {
        srcRow('Dataset', init.gbifDataset);
        srcRow('Locatie', init.gbifLocality);
        srcRow('Levensstadium', LIFE[init.gbifLifestage] || init.gbifLifestage);
        srcRow('Geslacht', SEX[init.gbifSex] || init.gbifSex);
        srcRow('Gedrag', init.gbifBehavior);
        srcRow('Registratietype', BASIS[init.gbifBasis] || init.gbifBasis);
        srcRow('Land', init.gbifCountry);
        if (init.gbifCoordPrec) srcRow('Nauwkeurigheid', '±' + init.gbifCoordPrec + 'm');
        if (init.gbifCoordUncertainty) srcRow('Onzekerheid coord.', '±' + init.gbifCoordUncertainty + 'm');
        if (init.gbifCoordJittered) srcRow('Locatie', '⚠️ Afgeronde coördinaat — positie bij benadering');
        if (init.gbifIssues) srcRow('Opmerkingen', init.gbifIssues);
        if (init.gbifUrl) srcRow('GBIF link', 'Bekijk op gbif.org', init.gbifUrl);
      } else {
        srcRow('Locatie', init.location);
        srcRow('Validatiestatus', init.validationStatus);
        if (init.permalink) srcRow('Link', 'Bekijk op waarneming.nl', init.permalink);
      }
      srcBlock.style.display = 'block';
    } else {
      srcBlock.style.display = 'none';
    }
  }
  // Read-only modus (geïmporteerde waarnemingen)
  const ro = readOnly || !onSave;
  const fields = ['pm-date','pm-by','pm-amount','pm-note','pm-nesttype','pm-ruimer','pm-methode','pm-valtype','pm-koninginnen'];
  fields.forEach(id=>{ const el=document.getElementById(id); if(el){ el.disabled=ro; el.style.opacity=ro?'0.7':''; } });
  ['pm-sender-ja','pm-sender-nee','pm-succes-ja','pm-succes-nee'].forEach(id=>{ const el=document.getElementById(id); if(el) el.disabled=ro; });
  if(pmSave2) pmSave2.style.display = ro ? 'none' : '';
  if(pmCancel2) pmCancel2.textContent = ro ? 'Sluiten' : 'Annuleren';
  // Modal tonen
  modalEl2.classList.remove('hidden');
  // Adres ophalen via reverse geocode
  const pmAddr = document.getElementById('pm-address');
  if(pmAddr){
    pmAddr.textContent = '📍 adres ophalen…';
    const ll = init._latlng || init.latlng;
    const lat = ll?.lat ?? init.lat;
    const lng = ll?.lng ?? init.lng;
    if(lat != null && lng != null){
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`, {headers:{'Accept-Language':'nl'}})
        .then(r=>r.json())
        .then(d=>{
          const a = d.address || {};
          const road   = a.road || a.pedestrian || a.path || '';
          const nr     = a.house_number || '';
          const city   = a.city || a.town || a.village || a.hamlet || '';
          pmAddr.textContent = '📍 ' + [road + (nr ? ' ' + nr : ''), city].filter(Boolean).join(', ');
        })
        .catch(()=>{ pmAddr.textContent = ''; });
    } else {
      pmAddr.textContent = '';
    }
  }
  function cleanup(){
    if(pmCancel2) pmCancel2.onclick=null;
    if(pmSave2) pmSave2.onclick=null;
    modalEl2.classList.add('hidden');
  }
  if(pmCancel2) pmCancel2.onclick = ()=>cleanup();
  if(pmSave2) pmSave2.onclick = ()=>{
    const pmNote3 = document.getElementById('pm-note');
    const vals={ date: pmDate2?.value || nowISODate(), by: pmBy2?.value || '', note: pmNote3?.value?.trim()||'' };
    if(type==='hoornaar' && pmAmount2){ const a=parseInt(pmAmount2.value,10); if(!isNaN(a)) vals.aantal=a; }
    if(type==='lokpot'){
      const jaEl2 = document.getElementById('pm-sender-ja');
      vals.sender = (jaEl2?.checked) ? 'ja' : 'nee';
    }
    if(type==='nest'){
      const v = document.getElementById('pm-nesttype')?.value;
      if(v) vals.nesttype = v;
    }
    if(type==='nest_geruimd'){
      const r = document.getElementById('pm-ruimer')?.value?.trim();
      const m = document.getElementById('pm-methode')?.value;
      const s = document.getElementById('pm-succes-ja')?.checked ? 'ja' : 'nee';
      if(r) vals.ruimer  = r;
      if(m) vals.methode = m;
      vals.succes = s;
    }
    if(type==='val'){
      const vt = document.getElementById('pm-valtype')?.value;
      const kn = parseInt(document.getElementById('pm-koninginnen')?.value, 10);
      if(vt) vals.valtype = vt;
      if(!isNaN(kn)) vals.koninginnen = kn;
    }
    onSave && onSave(vals); _logAction(type, vals); cleanup();
  };
}

// Kleur picker modal voor polygonen
function openColorModal(currentColor, onSave){
  const modal = document.getElementById('color-modal');
  const cmColor = document.getElementById('cm-color');
  const cmSave  = document.getElementById('cm-save');
  const cmCancel= document.getElementById('cm-cancel');
  if(!modal) return;
  if(cmColor) cmColor.value = currentColor || '#0aa879';
  modal.classList.remove('hidden');
  function cleanup(){ if(cmSave) cmSave.onclick=null; if(cmCancel) cmCancel.onclick=null; modal.classList.add('hidden'); }
  if(cmCancel) cmCancel.onclick = ()=>cleanup();
  if(cmSave) cmSave.onclick = ()=>{ onSave && onSave(cmColor?.value || '#0aa879'); cleanup(); };
}
// ======================= Filter modal =======================
function openFilterModal(){
  let modal = document.getElementById('filter-modal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'filter-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:20px 24px;min-width:260px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,.25)">
        <h3 style="margin:0 0 14px;font-size:15px;color:#0f172a">🔽 Filter</h3>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:14px">
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_hoornaar" checked/> 🐝 Waarneming</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_nest" checked/> 🪹 Nest</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_nest_geruimd" checked/> ✅ Nest geruimd</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_lokpot" checked/> 🪤 Lokpot</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_val" checked/> 🪝 Val</label>
          <div style="border-top:1px solid #e2e8f0;margin-top:4px;padding-top:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-size:13px;color:#475569">Periode</span>
              <span id="fm_period_label" style="font-size:13px;font-weight:600;color:#0aa879">Alles</span>
            </div>
            <input type="range" id="fm_period_slider" min="0" max="7" value="0" style="width:100%;accent-color:#0aa879;cursor:pointer"/>
            <div style="display:flex;justify-content:space-between;margin-top:2px">
              <span style="font-size:10px;color:#94a3b8">Alles</span>
              <span style="font-size:10px;color:#94a3b8">1 jaar</span>
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;border-top:1px solid #e2e8f0;padding-top:10px"><input type="checkbox" id="fm_poly_outline"/> Polygonen alleen omtrek</label>
          <label style="display:flex;align-items:center;gap:8px;padding-top:4px"><input type="checkbox" id="fm_show_gbif"/> 🌍 Verberg GBIF waarnemingen</label>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button id="fm_reset" style="flex:1;padding:8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:13px">Reset</button>
          <button id="fm_apply" style="flex:2;padding:8px;border-radius:6px;border:none;background:#0aa879;color:#fff;cursor:pointer;font-size:13px;font-weight:600">Toepassen</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    // Slider label
    const sl = modal.querySelector('#fm_period_slider');
    const lb = modal.querySelector('#fm_period_label');
    sl.addEventListener('input', ()=>{ lb.textContent = (PERIOD_STEPS[+sl.value]||PERIOD_STEPS[0]).label; });
    // Reset
    modal.querySelector('#fm_reset').addEventListener('click', ()=>{
      ['fm_hoornaar','fm_nest','fm_nest_geruimd','fm_lokpot','fm_val'].forEach(id=>{ const el=modal.querySelector('#'+id); if(el) el.checked=true; });
      sl.value='0'; lb.textContent='Alles';
      modal.querySelector('#fm_poly_outline').checked = false;
      modal.querySelector('#fm_show_gbif').checked = false; // uit = GBIF zichtbaar
    });
    // Apply
    modal.querySelector('#fm_apply').addEventListener('click', ()=>{
      [['fm_hoornaar','f_type_hoornaar'],['fm_nest','f_type_nest'],['fm_nest_geruimd','f_type_nest_geruimd'],
       ['fm_lokpot','f_type_lokpot'],['fm_val','f_type_val']].forEach(([src,dst])=>{
        const srcEl=modal.querySelector('#'+src); const dstEl=$(dst);
        if(srcEl && dstEl) dstEl.checked=srcEl.checked;
      });
      const dstSlider=$('f_period_slider'); if(dstSlider){ dstSlider.value=sl.value; updatePeriodLabel(+sl.value); }
      const dstOutline=$('f_poly_outline'); if(dstOutline) dstOutline.checked=modal.querySelector('#fm_poly_outline').checked;
      const dstGbif=$('f_show_gbif'); if(dstGbif) dstGbif.checked=modal.querySelector('#fm_show_gbif').checked;
      applyFilters();
      _closeFilterModal();
      _updateFilterBadge();
    });
    modal.addEventListener('click', e=>{ if(e.target===modal) _closeFilterModal(); });
  }
  // Sync huidige staat naar modal
  [['f_type_hoornaar','fm_hoornaar'],['f_type_nest','fm_nest'],['f_type_nest_geruimd','fm_nest_geruimd'],
   ['f_type_lokpot','fm_lokpot'],['f_type_val','fm_val']].forEach(([src,dst])=>{
    const srcEl=$(src); const dstEl=modal.querySelector('#'+dst);
    if(srcEl && dstEl) dstEl.checked=srcEl.checked;
  });
  const sl=$('f_period_slider'); const fmSl=modal.querySelector('#fm_period_slider');
  if(sl && fmSl){ fmSl.value=sl.value; modal.querySelector('#fm_period_label').textContent=(PERIOD_STEPS[+sl.value]||PERIOD_STEPS[0]).label; }
  const fo=$('f_poly_outline'); const fmFo=modal.querySelector('#fm_poly_outline');
  if(fo && fmFo) fmFo.checked=fo.checked;
  const fmGbif=modal.querySelector('#fm_show_gbif'); const dstGbifEl=$('f_show_gbif');
  if(fmGbif && dstGbifEl) fmGbif.checked=dstGbifEl.checked;
  modal.style.display='flex';
}
function _closeFilterModal(){ const m=document.getElementById('filter-modal'); if(m) m.style.display='none'; }
function _updateFilterBadge(){
  const allTypes = ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_val'].every(id=>$(id)?.checked!==false);
  const period = +($('f_period_slider')?.value||0);
  const gbifOn = !!$('f_show_gbif')?.checked;
  const active = !allTypes || period>0 || gbifOn;
  const wrapper = document.querySelector('.pm-icon-filter');
  if(wrapper) wrapper.classList.toggle('filter-active', active);
  const svgPath = document.querySelector('.pm-icon-filter path');
  if(svgPath) svgPath.setAttribute('fill', active ? '#0aa879' : '#d97706');
}

// ======================= Actie log =======================
const _actionLog = [];
function _logAction(type, meta, marker){
  const labels = { hoornaar:'Waarneming', nest:'Nest', nest_geruimd:'Nest geruimd', lokpot:'Lokpot', val:'Val', polygon:'Polygoon' };
  const icons  = { hoornaar:'\u{1F41D}', nest:'\u{1FAB9}', nest_geruimd:'\u2705', lokpot:'\u{1FA24}', val:'\u{1FA9D}', polygon:'\u2B21' };
  const label  = labels[type] || type;
  const icon   = icons[type]  || '\u{1F4CD}';
  const time   = new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'});
  _actionLog.unshift({ icon, label, time, note: meta?.note||'', by: meta?.by||'', marker, type });
  if(_actionLog.length > 50) _actionLog.pop();
  _renderActionLog();
}
function _renderActionLog(){
  const el = document.getElementById('action-log-list');
  if(!el) return;
  if(!_actionLog.length){ el.innerHTML='<div style="color:#94a3b8;font-size:12px;padding:6px 0">Nog geen acties deze sessie.</div>'; return; }
  el.innerHTML = '';
  _actionLog.forEach((a, idx) => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #e2e8f0;cursor:pointer;border-radius:4px';
    div.innerHTML = '<span style="font-size:16px;flex-shrink:0">'+a.icon+'</span>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-size:13px;font-weight:600;color:#1e293b">'+a.label+'</div>'
      + (a.note ? '<div style="font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+a.note+'</div>' : '')
      + (a.by ? '<div style="font-size:11px;color:#94a3b8">'+a.by+'</div>' : '')
      + '</div>'
      + '<span style="font-size:11px;color:#94a3b8;flex-shrink:0">'+a.time+'</span>';
    div.addEventListener('mouseenter', ()=>div.style.background='#f1f5f9');
    div.addEventListener('mouseleave', ()=>div.style.background='');
    if(a.marker){
      div.title = 'Klik om eigenschappen te bewerken';
      div.addEventListener('click', ()=>{
        window._setSidebar?.(false);
        openPropModal({
          type: a.type,
          init: {...a.marker._meta, _latlng: a.marker.getLatLng()},
          onSave:(vals)=>{ applyPropsToMarker(a.marker, vals); persistMarker(a.marker); _actionLog[idx].note=vals.note||''; _renderActionLog(); }
        });
      });
    }
    el.appendChild(div);
  });
}

// ======================= Marker workflow =======================
function attachMarkerPopup(marker){
  const m=marker._meta||{};
  const cap = s => s ? s.charAt(0).toUpperCase()+s.slice(1) : '';
  const typeLabel = m.type==='hoornaar'?(m.aantal?'Waarneming (\u00d7'+m.aantal+')':'Waarneming')
    :m.type==='nest'?'Nest gevonden':m.type==='nest_geruimd'?'Nest geruimd'
    :m.type==='lokpot'?'Lokpot':m.type==='val'?'Val geplaatst':'Icoon';
  const row = (lbl,val) => '<div style="display:flex;gap:6px;margin-top:4px"><span style="color:#94a3b8;font-size:11px;min-width:90px;flex-shrink:0">'+lbl+'</span><span style="font-size:12px;color:#1e293b;word-break:break-word">'+val+'</span></div>';
  const rowLink = (lbl,txt,href) => '<div style="display:flex;gap:6px;margin-top:4px"><span style="color:#94a3b8;font-size:11px;min-width:90px;flex-shrink:0">'+lbl+'</span><a href="'+href+'" target="_blank" style="font-size:12px;color:#0aa879;text-decoration:none">'+txt+'</a></div>';
  let rows = '';
  if(m.date) rows += row('Datum', m.date);
  if(m.by)   rows += row('Door', m.by);
  if(m.type==='hoornaar' && m.aantal) rows += row('Aantal', String(m.aantal));
  if(m.type==='lokpot' && m.sender)   rows += row('Zender', m.sender==='ja'?'Ja':'Nee');
  if(m.type==='nest' && m.nesttype)   rows += row('Nesttype', cap(m.nesttype));
  if(m.type==='nest_geruimd'){
    if(m.ruimer)  rows += row('Geruimd door', m.ruimer);
    if(m.methode) rows += row('Methode', cap(m.methode));
    if(m.succes)  rows += row('Succesvol', m.succes==='ja'?'Ja':'Nee');
  }
  if(m.type==='val'){
    if(m.valtype)           rows += row('Type val', cap(m.valtype));
    if(m.koninginnen!=null) rows += row('Koninginnen', String(m.koninginnen));
  }
  if(m.note) rows += '<div style="margin-top:5px;padding-top:4px;border-top:1px solid #e2e8f0;font-size:12px;color:#374151;font-style:italic">'+m.note+'</div>';
  let srcRows = '';
  if(m.source==='GBIF' || m.source==='waarneming.nl'){
    const LIFE={'ADULT':'Volwassen','JUVENILE':'Juveniel','LARVA':'Larve','PUPA':'Pop','EGG':'Ei'};
    const SEX={'FEMALE':'Vrouwtje','MALE':'Mannetje'};
    srcRows += '<div style="margin-top:8px;padding-top:6px;border-top:1px solid #e2e8f0">';
    srcRows += '<div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:4px">\ud83d\udce1 Bron: '+m.source+'</div>';
    if(m.source==='GBIF'){
      if(m.gbifDataset)   srcRows += row('Dataset', m.gbifDataset);
      if(m.gbifLocality)  srcRows += row('Locatie', m.gbifLocality);
      if(m.gbifLifestage && LIFE[m.gbifLifestage]) srcRows += row('Stadium', LIFE[m.gbifLifestage]);
      if(m.gbifSex && SEX[m.gbifSex]) srcRows += row('Geslacht', SEX[m.gbifSex]);
      if(m.gbifBehavior)  srcRows += row('Gedrag', m.gbifBehavior);
      if(m.gbifCoordPrec) srcRows += row('Nauwkeurigheid', '\u00b1'+m.gbifCoordPrec+'m');
      if(m.gbifIssues)    srcRows += row('Issues', m.gbifIssues);
      if(m.gbifUrl)       srcRows += rowLink('GBIF link', 'Bekijk op gbif.org', m.gbifUrl);
    } else {
      if(m.location)         srcRows += row('Locatie', m.location);
      if(m.validationStatus) srcRows += row('Validatie', m.validationStatus);
      if(m.permalink)        srcRows += rowLink('Link', 'waarneming.nl', m.permalink);
    }
    srcRows += '</div>';
  }
  // Klik op marker opent eigenschappen in prop-modal (inclusief GBIF brondata)
  marker.unbindPopup();
  marker.unbindTooltip();
  marker.on('click', (e)=>{
    L.DomEvent.stopPropagation(e);
    const isImport = m.source === 'GBIF' || m.source === 'waarneming.nl';
    openPropModal({
      type: m.type,
      init: {...m, _latlng: marker.getLatLng()},
      readOnly: isImport,
      onSave: isImport ? null : (vals)=>{ applyPropsToMarker(marker, vals); persistMarker(marker); }
    });
  });
}
function applyPropsToMarker(marker, vals){
  const m=marker._meta||{};
  if(vals.date) m.date=vals.date; else delete m.date;
  if(vals.by) m.by=vals.by; else delete m.by;
  if(vals.note!==undefined){ if(vals.note) m.note=vals.note; else delete m.note; }
  if(vals.sender!==undefined){ m.sender=vals.sender; }
  if(m.type==='hoornaar'){ if(vals.aantal!=null) m.aantal=vals.aantal; else delete m.aantal; }
  if(m.type==='nest'){
    if(vals.nesttype) m.nesttype=vals.nesttype; else delete m.nesttype;
  }
  if(m.type==='nest_geruimd'){
    if(vals.ruimer)  m.ruimer=vals.ruimer;   else delete m.ruimer;
    if(vals.methode) m.methode=vals.methode; else delete m.methode;
    if(vals.succes)  m.succes=vals.succes;   else delete m.succes;
  }
  if(m.type==='val'){
    if(vals.valtype)           m.valtype=vals.valtype;         else delete m.valtype;
    if(vals.koninginnen!=null) m.koninginnen=vals.koninginnen; else delete m.koninginnen;
  }
  marker.setIcon(getIconForMarker(m));
  marker._meta=m; attachMarkerPopup(marker);
}
function placeMarkerAt(latlng, type='pending'){
  const id = genId('mk'); let marker;
  // Markers zijn NIET meer vrij draggable — verplaatsen gaat via contextmenu
  if(type==='lokpot'){ const potId=genId('pot'); marker=L.marker(latlng,{draggable:false}); marker._meta={id,type,potId}; }
  else { marker=L.marker(latlng,{draggable:false}); marker._meta={id,type:(type||'pending')}; }
  marker.setIcon(getIconForMarker(marker._meta));
  // Mobiel: long-press opent contextmenu (preventDefault stopt browser download-dialoog)
  let _mLpTimer = null;
  marker.on('contextmenu', e=>{
    e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation();
    if(shouldDebounce()) return;
    openMarkerContextMenu(marker, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
  marker.on('touchstart', e=>{
    e.originalEvent?.preventDefault();
    const t = e.originalEvent?.touches?.[0];
    _mLpTimer = setTimeout(()=>{
      if(shouldDebounce()) return;
      openMarkerContextMenu(marker, t?.clientX||0, t?.clientY||0);
    }, 600);
  }, {passive: false});
  marker.on('touchend touchmove', ()=>clearTimeout(_mLpTimer));
  // Verplaatsen via drag
  if(canWrite()){
    marker.on('drag', () => {
      // Lokpot: lijnen en sectoren live meeverplaatsen
      if(marker._meta?.type === 'lokpot' && marker._meta?.potId) {
        const newLL = marker.getLatLng();
        movePotLines(marker._meta.potId, newLL);
      }
    });
    marker.on('dragend', () => {
      persistMarker(marker);
      // Na dragend ook lijnen/sectoren persisteren
      if(marker._meta?.type === 'lokpot' && marker._meta?.potId) {
        const newLL = marker.getLatLng();
        allLines.forEach(l => {
          if(l._meta?.potId === marker._meta.potId) {
            l._meta.pot = { lat: newLL.lat, lng: newLL.lng, id: marker._meta.potId };
            persistLine(l);
          }
        });
      }
    });
  }
  allMarkers.push(marker); markersGroup.addLayer(marker); attachMarkerPopup(marker);
  return marker;
}
function createMarkerWithPropsAt(latlng, type, vals){
  const marker = placeMarkerAt(latlng, type);
  applyPropsToMarker(marker, vals);
  return marker;
}
function deleteMarkerAndAssociations(marker){
  const meta=marker._meta||{};
  if(meta.type==='lokpot' && meta.potId){ removePotAssociations(meta.potId); }
  markersGroup.removeLayer(marker); allMarkers = allMarkers.filter(m=>m!==marker);
}
function persistMarker(marker){
  const m=marker._meta||{}; if(!m.id) m.id=genId('mk'); marker._meta=m;
  const ll=marker.getLatLng();
  const doc = {
    id:m.id, type:m.type, lat:ll.lat, lng:ll.lng,
    date:m.date||null, by:m.by||null, aantal:m.aantal!=null? m.aantal:null,
    potId:m.potId||null, note:m.note||null, sender:m.sender||null,
    nesttype:m.nesttype||null,
    ruimer:m.ruimer||null, methode:m.methode||null, succes:m.succes||null,
    valtype:m.valtype||null, koninginnen:m.koninginnen!=null?m.koninginnen:null
  };
  saveMarkerToCloud(doc);
}
// ======================= Zichtlijnen =======================
const R_EARTH=6371000;
const toRad=d=>d*Math.PI/180, toDeg=r=>r*180/Math.PI;
function bearingBetween(a,b){
  const phi1=toRad(a.lat),phi2=toRad(b.lat), dlam=toRad(b.lng-a.lng);
  const y=Math.sin(dlam)*Math.cos(phi2);
  const x=Math.cos(phi1)*Math.sin(phi2)-Math.sin(phi1)*Math.cos(phi2)*Math.cos(dlam);
  const theta=Math.atan2(y,x); return (toDeg(theta)+360)%360;
}
function destinationPoint(start,distance,bearingDeg){
  const delta=distance/R_EARTH, theta=toRad(bearingDeg), phi1=toRad(start.lat), lam1=toRad(start.lng);
  const sin1=Math.sin(phi1), cos1=Math.cos(phi1), sind=Math.sin(delta), cosd=Math.cos(delta);
  const sin2=sin1*cosd + cos1*sind*Math.cos(theta); const phi2=Math.asin(sin2);
  const y=Math.sin(theta)*sind*cos1; const x=cosd - sin1*sin2; const lam2=lam1+Math.atan2(y,x);
  return L.latLng(toDeg(phi2),((toDeg(lam2)+540)%360)-180);
}
function arcPoints(center,radius,startDeg,endDeg,steps=32){
  const pts=[],total=endDeg-startDeg,step=total/steps;
  for(let i=0;i<=steps;i++) pts.push(destinationPoint(center,radius,startDeg+step*i));
  return pts;
}
function registerLine(line){ if(!allLines.includes(line)) allLines.push(line); }
function registerSector(sector){ if(!allSectors.includes(sector)) allSectors.push(sector); }
function makeHandleIcon(){ return L.divIcon({className:'line-handle',html:'<div></div>',iconSize:[12,12],iconAnchor:[6,6]}); }
function setSightLineColor(line,color,save=false){
  line.setStyle({color});
  line._meta=line._meta||{}; line._meta.color=color;
  if(line._sector){
    line._sector.setStyle({color, fillColor:color});
    line._sector._meta.color=color;
    if(save) persistSector(line._sector);
  }
  if(save) persistLine(line);
}
function deleteSightLine(line, fromMenu=false){
  const id = line._meta?.id;
  if(line._handle){ handlesGroup.removeLayer(line._handle); line._handle=null; }
  if(line._sector){ const sid=line._sector._meta?.id; if(sid){ deleteSectorFromCloud(sid); } circlesGroup.removeLayer(line._sector); line._sector=null; }
  if(line._distLabel){ try{ map.removeLayer(line._distLabel); }catch{} line._distLabel=null; }
  if(line.getTooltip()) line.unbindTooltip();
  linesGroup.removeLayer(line); allLines = allLines.filter(l=>l!==line);
  if(fromMenu && id){ deleteLineFromCloud(id); }
}
function createSectorLayer({id, pot,distance,color='#ffcc00',bearing,rInner,rOuter,angleLeft=45,angleRight=45,steps=36,flightId}){
  const center=L.latLng(pot.lat,pot.lng); const start=bearing-angleLeft; const end=bearing+angleRight;
  const outer=arcPoints(center,rOuter,start,end,steps);
  const inner=arcPoints(center,rInner,end,start,steps);
  const ring=[...outer,...inner];
  const poly=L.polygon(ring,{color,weight:1,dashArray:'6 6',fillColor:color,fillOpacity:0.25});
  poly._meta={ id, type:'sector', pot, distance, color, bearing, rInner, rOuter, angleLeft, angleRight, steps, flightId };
  return poly;
}
function attachSightLineInteractivity(line){
  const meta=line._meta||{}; if(meta.type!=='flight') return;
  const pot=L.latLng(meta.pot.lat,meta.pot.lng);
  const end=line.getLatLngs()[1];
  line.on('contextmenu',e=>{
    e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation();
    if(shouldDebounce()) return; openLineContextMenu(line, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
  if(line._handle){ handlesGroup.removeLayer(line._handle); line._handle=null; }
  const handle=L.marker(end,{icon:makeHandleIcon(),draggable:true,zIndexOffset:1500}).addTo(handlesGroup);
  line._handle=handle;
  handle.on('contextmenu',e=>{
    e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation();
    if(shouldDebounce()) return; openLineContextMenu(line, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
  handle.on('drag',()=>{
    const raw=handle.getLatLng();
    const brg=bearingBetween(pot,raw); const dist=Math.max(1,Math.round(pot.distanceTo(raw)));
    const constrained=destinationPoint(pot,dist,brg);
    handle.setLatLng(constrained); line.setLatLngs([pot,constrained]);
    line._meta.bearing=brg; line._meta.distance=dist;
    if(line._distLabel){ line._distLabel.setContent(`${dist} m`).setLatLng(constrained); }
    if(line._sector){ circlesGroup.removeLayer(line._sector); line._sector=null; }
    const rInner=Math.max(1,dist-25), rOuter=dist+25;
    const sector=createSectorLayer({
      id: line._sector? line._sector._meta?.id : genId('sect'),
      pot: meta.pot, distance:dist, color:line._meta.color||'#ffcc00',
      bearing:brg, rInner, rOuter, angleLeft:45, angleRight:45, steps:36, flightId: meta.id
    }).addTo(circlesGroup);
    registerSector(sector); line._sector=sector; sector._line=line;
    persistLine(line); persistSector(sector);
  });
}
function startSightLine(lokpotMarker){
  const potLatLng=lokpotMarker.getLatLng();
  let dist = prompt('Afstand tot nest (meter):','200'); if(dist===null) return;
  dist=Math.max(1, parseInt(dist,10) || 1);
  const defaultColor = '#'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0');
  const tempGuide=L.polyline([potLatLng,potLatLng],{color:defaultColor,weight:2,dashArray:'4 4'}).addTo(map);
  const onMove=(e)=>{ tempGuide.setLatLngs([potLatLng,e.latlng]); };
  const onClick=(e)=>{
    map.off('mousemove', onMove); map.off('click', onClick); tempGuide.remove();
    const clicked=e.latlng; const brg=bearingBetween(potLatLng, clicked);
    const endLatLng=destinationPoint(potLatLng, dist, brg);
    const id=genId('flight');
    const line=L.polyline([potLatLng, endLatLng],{color:defaultColor,weight:3}).addTo(linesGroup);
    line._meta={ id, type:'flight',
      pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:lokpotMarker._meta?.potId||null},
      potId: lokpotMarker._meta?.potId||null, distance:dist, color:defaultColor, bearing:brg
    };
    registerLine(line);
    // Tooltip als losse marker op het eindpunt zodat hij daar vast blijft
    line._distLabel = L.tooltip({permanent:true,direction:'right',offset:[8,0],className:'line-label'})
      .setContent(`${dist} m`)
      .setLatLng(endLatLng)
      .addTo(map);
    const rInner=Math.max(1,dist-25), rOuter=dist+25;
    const sector=createSectorLayer({
      id: genId('sect'), pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:lokpotMarker._meta?.potId||null},
      distance:dist, color:defaultColor, bearing:brg, rInner, rOuter, angleLeft:45, angleRight:45, steps:36, flightId:id
    }).addTo(circlesGroup);
    registerSector(sector); line._sector=sector; sector._line=line;
    attachSightLineInteractivity(line);
    persistLine(line); persistSector(sector);
  };
  map.on('mousemove', onMove); map.on('click', onClick);
}
function persistLine(line){
  const m=line._meta||{}, ll=line.getLatLngs();
  const doc = {
    id:m.id, type:'flight',
    pot:m.pot||null, potId:m.potId||null,
    distance:m.distance||0, color:m.color||'#ffcc00', bearing:m.bearing||0,
    note: m.note||'',
    latlngs: ll.map(p=>({lat:p.lat,lng:p.lng}))
  };
  saveLineToCloud(doc);
}
function persistSector(sector){
  const m=sector._meta||{};
  const doc = { id:m.id, type:'sector', pot:m.pot||null, distance:m.distance||0,
    color:m.color||'#ffcc00', bearing:m.bearing||0, rInner:m.rInner||0, rOuter:m.rOuter||0,
    angleLeft:m.angleLeft||45, angleRight:m.angleRight||45, steps:m.steps||36, flightId:m.flightId||null };
  saveSectorToCloud(doc);
}
// Verplaats alle lijnen/sectoren van een pot naar nieuwe positie (live tijdens drag)
function movePotLines(potId, newLatLng) {
  allLines.forEach(line => {
    const m = line._meta || {};
    if(m.potId !== potId) return;
    const brg = m.bearing || 0;
    const dist = m.distance || 100;
    const newEnd = destinationPoint(newLatLng, dist, brg);
    // Lijn verplaatsen
    line.setLatLngs([newLatLng, newEnd]);
    // Handle meeverplaatsen
    if(line._handle) line._handle.setLatLng(newEnd);
    // Tooltip positie
    if(line._distLabel){ line._distLabel.setContent(`${dist} m`).setLatLng(constrained); }
    // Sector meeverplaatsen
    if(line._sector) {
      const sm = line._sector._meta || {};
      circlesGroup.removeLayer(line._sector);
      const newSector = createSectorLayer({
        id: sm.id, pot: { lat: newLatLng.lat, lng: newLatLng.lng, id: potId },
        distance: dist, color: sm.color || '#ffcc00',
        bearing: brg, rInner: sm.rInner || Math.max(1, dist-25),
        rOuter: sm.rOuter || dist+25,
        angleLeft: sm.angleLeft || 45, angleRight: sm.angleRight || 45,
        steps: sm.steps || 36, flightId: m.id
      }).addTo(circlesGroup);
      registerSector(newSector);
      newSector._line = line;
      line._sector = newSector;
    }
  });
}

function removePotAssociations(potId){
  const toRemoveLines=[]; allLines.forEach(l=>{ const m=l._meta||{}; if(m.potId===potId) toRemoveLines.push(l); });
  toRemoveLines.forEach(l=>{ const id=l._meta?.id; if(id){ deleteLineFromCloud(id); } deleteSightLine(l,false); });
  const toRemoveSectors=[]; allSectors.forEach(c=>{ const m=c._meta||{}; if(m.type==='sector'&&(m.pot?.id===potId||m.potId===potId)) toRemoveSectors.push(c); });
  toRemoveSectors.forEach(c=>{ const sid=c._meta?.id; if(sid){ deleteSectorFromCloud(sid); } circlesGroup.removeLayer(c); });
}
// ======================= Polygons =======================
function polygonCentroid(layer){
  try{
    const latlngs = layer.getLatLngs();
    const ring = Array.isArray(latlngs[0])? (Array.isArray(latlngs[0][0])?latlngs[0][0]:latlngs[0]) : latlngs;
    if(!ring || ring.length<3) return layer.getBounds().getCenter();
    let area=0,cx=0,cy=0;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
      const x0=ring[j].lng,y0=ring[j].lat,x1=ring[i].lng,y1=ring[i].lat; const f=x0*y1-x1*y0;
      area+=f; cx+=(x0+x1)*f; cy+=(y0+y1)*f;
    }
    area*=0.5; if(Math.abs(area)<1e-12) return layer.getBounds().getCenter();
    cx/=(6*area); cy/=(6*area); return L.latLng(cy,cx);
  }catch{ return layer.getBounds().getCenter(); }
}
function refreshPolygonLabel(layer){
  const lbl=layer._props?.label||''; const col=layer._props?.color||'#0aa879';
  // Label tonen als polygon in het actieve geselecteerde gebied zit
  const zoneId = layer._props?.zoneId || '';
  const activeZone = normalizeZone($('sel-group')?.value || DEFAULT_GROUP);
  const inZone = !zoneId || normalizeZone(zoneId) === activeZone;
  if(lbl){
    const pos = polygonCentroid(layer);
    if(!inZone){
      // Niet in eigen zone → label verbergen
      if(layer._labelTooltip){ map.removeLayer(layer._labelTooltip); layer._labelTooltip=null; }
    } else {
      if(!layer._labelTooltip){
        layer._labelTooltip = L.tooltip({permanent:true,direction:'center',className:'poly-label'}).setContent(lbl).setLatLng(pos);
      } else {
        layer._labelTooltip.setContent(lbl).setLatLng(pos);
      }
      // Alleen tonen als zoom hoog genoeg
      const shouldShow = (map?.getZoom()||15) >= ZOOM_LABELS;
      if(shouldShow && !map.hasLayer(layer._labelTooltip)) layer._labelTooltip.addTo(map);
      else if(!shouldShow && map.hasLayer(layer._labelTooltip)) map.removeLayer(layer._labelTooltip);
      // Kleur
      const el = layer._labelTooltip.getElement?.();
      if(el) el.style.borderColor = col;
    }
  } else {
    if(layer._labelTooltip){ map.removeLayer(layer._labelTooltip); layer._labelTooltip=null; }
  }
}
function initPolygon(layer){
  layer._props = layer._props || { id: genId('poly'), label:'', color:'#0aa879' };
  const col = layer._props.color||'#0aa879';
  layer.setStyle({ color: col, fillColor: col, fillOpacity: .2, weight: 3 });
  refreshPolygonLabel(layer);
  // Desktop: contextmenu / click opent menu direct
  // Mobiel: long press (600ms, <10px beweging)
  layer.on('contextmenu', ev => {
    ev.originalEvent?.preventDefault(); ev.originalEvent?.stopPropagation();
    if(shouldDebounce()) return;
    openUnifiedContextMenu({ x:ev.originalEvent?.clientX||0, y:ev.originalEvent?.clientY||0, latlng:ev.latlng, polygonLayer: layer });
  });
  let _polyLp = null, _polyMoved = false, _polyXY = null;
  layer.on('mousedown touchstart', ev => {
    _polyMoved = false;
    const t = ev.originalEvent?.touches?.[0];
    _polyXY = { x: t?.clientX ?? ev.originalEvent?.clientX ?? 0, y: t?.clientY ?? ev.originalEvent?.clientY ?? 0 };
    clearTimeout(_polyLp);
    _polyLp = setTimeout(() => {
      if (!_polyMoved && !shouldDebounce()) {
        openUnifiedContextMenu({ x: _polyXY.x, y: _polyXY.y, latlng: ev.latlng, polygonLayer: layer });
      }
    }, 600);
  });
  layer.on('mousemove touchmove', ev => {
    const t = ev.originalEvent?.touches?.[0];
    const cx = t?.clientX ?? ev.originalEvent?.clientX ?? 0;
    const cy = t?.clientY ?? ev.originalEvent?.clientY ?? 0;
    if (_polyXY && (Math.abs(cx - _polyXY.x) > 10 || Math.abs(cy - _polyXY.y) > 10)) {
      _polyMoved = true; clearTimeout(_polyLp);
    }
  });
  layer.on('mouseup touchend', () => clearTimeout(_polyLp));
}
async function _copyPolygonToYear(layer){
  const curYear = $('sel-year')?.value || DEFAULT_YEAR;
  const curY = new Date().getFullYear();
  // Bouw jaar-opties: 2020 t/m huidig, exclusief huidig jaar
  const options = [];
  for(let y = curY; y >= 2020; y--) if(String(y) !== curYear) options.push(String(y));
  if(!options.length){ alert('Geen andere jaren beschikbaar.'); return; }

  // Toon een kleine modal met jaar-keuze
  const existing = document.getElementById('poly-copy-modal');
  if(existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'poly-copy-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
  modal.innerHTML = `<div style="background:#fff;border-radius:12px;padding:20px 24px;min-width:240px;box-shadow:0 8px 32px rgba(0,0,0,.25)">
    <h3 style="margin:0 0 14px;font-size:15px">📋 Kopiëren naar jaar</h3>
    <p style="font-size:13px;color:#475569;margin:0 0 12px">Polygoon: <strong>${layer._props?.label||'(geen naam)'}</strong><br>Vanuit jaar: ${curYear}</p>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px" id="poly-copy-years">
      ${options.map(y=>`<label style="display:flex;align-items:center;gap:8px;font-size:14px"><input type="checkbox" value="${y}"/> ${y}</label>`).join('')}
    </div>
    <div style="display:flex;gap:8px">
      <button id="poly-copy-cancel" style="flex:1;padding:8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer">Annuleren</button>
      <button id="poly-copy-ok" style="flex:2;padding:8px;border-radius:6px;border:none;background:#0aa879;color:#fff;cursor:pointer;font-weight:600">Kopiëren</button>
    </div>
    <div id="poly-copy-status" style="font-size:12px;margin-top:8px;min-height:16px;color:#64748b"></div>
  </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#poly-copy-cancel').onclick = ()=>modal.remove();
  modal.querySelector('#poly-copy-ok').onclick = async ()=>{
    const checked = [...modal.querySelectorAll('#poly-copy-years input:checked')].map(i=>i.value);
    if(!checked.length){ alert('Selecteer minimaal één jaar.'); return; }
    const status = modal.querySelector('#poly-copy-status');
    const okBtn = modal.querySelector('#poly-copy-ok');
    okBtn.disabled = true; okBtn.textContent = '⏳ Bezig…';

    const props = layer._props || {};
    const latlngs = layer.getLatLngs().flat(3).map(p=>({lat:p.lat,lng:p.lng}));
    const group = props.zoneId || normalizeZone($('sel-group')?.value || DEFAULT_GROUP);
    const _db2 = getFirestore(app);

    let done = 0;
    for(const yr of checked){
      try{
        const newId = genId('poly');
        const path = `maps/${yr}/${group}/data/polygons/${newId}`;
        await setDoc(doc(_db2, path), { id:newId, label:props.label||'', color:props.color||'#0aa879', latlngs, zoneId:group });
        done++;
        status.textContent = `✅ Gekopieerd naar ${yr}`;
      } catch(e){
        status.textContent = `❌ Fout bij ${yr}: ${e.message}`;
      }
    }
    okBtn.textContent = `✅ Klaar (${done} jaar${done!==1?'en':''})`;
    setTimeout(()=>modal.remove(), 1500);
  };
}

function persistPolygon(layer){
  const id = layer._props?.id || genId('poly'); layer._props.id = id;
  const latlngs = layer.getLatLngs().flat(3).map(p=>({lat:p.lat,lng:p.lng}));
  // zoneId meeopslaan — nodig voor beheerder-opzoeken en zone filtering
  const zoneId = layer._props.zoneId || normalizeZone($('sel-group')?.value || '');
  if(!layer._props.zoneId) layer._props.zoneId = zoneId;
  const doc = { id, label:layer._props.label||'', color:layer._props.color||'#0aa879', latlngs, zoneId };
  savePolygonToCloud(doc);
}
// ======================= Unified contextmenu =======================
function openUnifiedContextMenu(opts){
  closeContextMenu();
  const el=document.createElement('div'); el.className='ctx-menu';
  let html='';
  if(opts.polygonLayer){
    const _mgr = getZoneManagerName(opts.polygonLayer._props?.zoneId);
    const _mgrTxt = _mgr ? ` <span style="font-size:11px;color:#64748b;font-weight:normal">(beheerder: ${_mgr})</span>` : '';
    if(canEdit()){
      html += `<h4>Polygoon${_mgrTxt}</h4>
    <button data-act="poly_label">✏️ Label wijzigen</button>
    <button data-act="poly_color">🎨 Kleur wijzigen</button>
    <button data-act="poly_edit">✍️ Vorm bewerken aan/uit</button>
    <button data-act="poly_copy">📋 Kopiëren naar jaar…</button>
    <button data-act="poly_delete">🗑️ Verwijderen</button>
    <hr/>`;
    } else {
      html += `<h4>Polygoon${_mgrTxt}</h4><hr/>`;
    }
  }
  if(canWrite()){
    html += `<h4>Nieuw icoon</h4>
    <button data-act="mk" data-type="hoornaar">Waarneming</button>
    <button data-act="mk" data-type="nest">Nest gevonden</button>
    <button data-act="mk" data-type="nest_geruimd">Nest geruimd</button>
    <button data-act="mk" data-type="lokpot">Lokpot</button>
    <button data-act="mk" data-type="val">Val geplaatst</button>`;
  }
  if(!html) return; // niets te tonen
  el.innerHTML=html;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    setTimeout(()=>{
      if(act==='mk'){ const m=createMarkerWithPropsAt(opts.latlng, b.dataset.type, {date:nowISODate()}); persistMarker(m); _logAction(b.dataset.type, {}); return; }
      if(!opts.polygonLayer) return;
      if(act==='poly_label'){ const lbl=prompt('Polygoon label:', opts.polygonLayer._props?.label||''); if(lbl===null) return; opts.polygonLayer._props.label=lbl; refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }
      else if(act==='poly_color'){ openColorModal(opts.polygonLayer._props?.color||'#0aa879', col=>{ opts.polygonLayer._props.color=col; opts.polygonLayer.setStyle({ color: col, fillColor: col }); refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }); }
      else if(act==='poly_copy'){ _copyPolygonToYear(opts.polygonLayer); }
      else if(act==='poly_delete'){ const id=opts.polygonLayer._props?.id; if(id){ deletePolygonFromCloud(id); } _removePolygonLayer(opts.polygonLayer); }
    },0);
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el, opts.x||0, opts.y||0);
  document.addEventListener('keydown', escClose); document.addEventListener('click', closeContextMenuOnce, true);
}
// ======================= Filters =======================
function getActiveFilters(){ 
  const idx = parseInt($('f_period_slider')?.value||'0', 10);
  const step = PERIOD_STEPS[idx] || PERIOD_STEPS[0];
  const isToday = step.days === 'today';
  const todayStr = new Date().toISOString().slice(0,10);
  return {
    hoornaar: !!$('f_type_hoornaar')?.checked,
    nest: !!$('f_type_nest')?.checked,
    nest_geruimd: !!$('f_type_nest_geruimd')?.checked,
    lokpot: !!$('f_type_lokpot')?.checked,
    val: !!$('f_type_val')?.checked,
    showGbif: !$('f_show_gbif')?.checked,  // checkbox = verberg, dus omgekeerd
    dateFrom: isToday ? todayStr : getDateFrom(step.days),
    dateOnlyToday: isToday,
    todayStr: todayStr
  };
}
function updatePeriodLabel(idx){
  const step = PERIOD_STEPS[idx] || PERIOD_STEPS[0];
  const lbl = $('f_period_label');
  if(lbl) lbl.textContent = step.label;
}

function applyFilters(){
  const f=getActiveFilters();
  allMarkers.forEach(m=>{
    const meta=m._meta||{}; let show=!!f[meta.type];
    // GBIF filter: verberg GBIF markers tenzij showGbif aan staat
    if(show && meta.source==='GBIF' && !f.showGbif) show=false;
    if(f.dateOnlyToday){
      // Vandaag: alleen iconen waarvan datum === vandaag
      if(!meta.date || meta.date !== f.todayStr) show=false;
    } else if(f.dateFrom && meta.date){ 
      if(meta.date < f.dateFrom) show=false; 
    }
    if(show) markersGroup.addLayer(m); else markersGroup.removeLayer(m);
  });
  const visiblePotIds=new Set();
  allMarkers.forEach(m=>{ const meta=m._meta||{}; if(meta.type==='lokpot' && markersGroup.hasLayer(m)) visiblePotIds.add(meta.potId); });
  // Polygoon omtrek-only
  const outlineOnly = !!$('f_poly_outline')?.checked;
  polygonsGroup.getLayers().forEach(layer => {
    const col = layer._props?.color || '#0aa879';
    layer.setStyle(outlineOnly
      ? { fillOpacity: 0, weight: 4 }
      : { fillColor: col, fillOpacity: 0.2, weight: 3 });
  });

  allLines.forEach(line=>{
    const meta=line._meta||{}; const should = visiblePotIds.has(meta.potId);
    // Lijn zelf
    const onMap = linesGroup.hasLayer(line);
    if(should && !onMap) linesGroup.addLayer(line);
    if(!should && onMap) linesGroup.removeLayer(line);
    // Handle
    if(line._handle){
      const inH = handlesGroup.hasLayer(line._handle);
      if(should && !inH) handlesGroup.addLayer(line._handle);
      if(!should && inH) handlesGroup.removeLayer(line._handle);
    }
    // Sector
    if(line._sector){
      const inS = circlesGroup.hasLayer(line._sector);
      if(should && !inS) circlesGroup.addLayer(line._sector);
      if(!should && inS) circlesGroup.removeLayer(line._sector);
    }
    // Afstandslabel
    if(line._distLabel){
      const zoom = map?.getZoom() || 14;
      const showDist = should && zoom >= ZOOM_LINES;
      const dle = line._distLabel.getElement?.();
      if(dle) dle.style.visibility = showDist ? '' : 'hidden';
    }
  });
}
// ======================= Cloud → kaart (realtime) =======================
function upsertMarkerFromCloud(doc){
  let m = allMarkers.find(x=>x._meta?.id===doc.id);
  if(!m){
    m = L.marker([doc.lat, doc.lng], { draggable: false });
    m._meta = {
      id: doc.id, type: doc.type, potId: doc.potId||null,
      date: doc.date||null, by: doc.by||null,
      aantal: doc.aantal!=null ? doc.aantal : null,
      note: doc.note||'', sender: doc.sender||null,
      nesttype: doc.nesttype||null,
      ruimer: doc.ruimer||null, methode: doc.methode||null, succes: doc.succes||null,
      valtype: doc.valtype||null, koninginnen: doc.koninginnen!=null ? doc.koninginnen : null,
      // Bron metadata
      source: doc.source||null, externalId: doc.externalId||null,
      gbifKey: doc.gbifKey||null, gbifDataset: doc.gbifDataset||null,
      gbifLocality: doc.gbifLocality||null, gbifBehavior: doc.gbifBehavior||null,
      gbifLifestage: doc.gbifLifestage||null, gbifSex: doc.gbifSex||null,
      gbifBasis: doc.gbifBasis||null, gbifIssues: doc.gbifIssues||null,
      gbifUrl: doc.gbifUrl||null, gbifCoordPrec: doc.gbifCoordPrec||null,
      gbifCoordUncertainty: doc.gbifCoordUncertainty||null,
      gbifCoordJittered: doc.gbifCoordJittered||false,
      gbifCountry: doc.gbifCountry||null,
      // waarneming.nl CSV
      validationStatus: doc.validationStatus||null, permalink: doc.permalink||null,
      location: doc.location||null,
    };
    m.setIcon(getIconForMarker(m._meta));
    m.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(shouldDebounce()) return; openMarkerContextMenu(m, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
    // Mobiel: long-press opent contextmenu (preventDefault stopt browser download-dialoog)
    let _mLp = null;
    m.on('touchstart', e=>{ e.originalEvent?.preventDefault(); const t=e.originalEvent?.touches?.[0]; _mLp=setTimeout(()=>{ if(shouldDebounce())return; openMarkerContextMenu(m, t?.clientX||0, t?.clientY||0); },600); },{passive:false});
    m.on('touchend touchmove', ()=>clearTimeout(_mLp));
    if(canWrite()){
      m.on('drag', () => {
        if(m._meta?.type === 'lokpot' && m._meta?.potId) {
          movePotLines(m._meta.potId, m.getLatLng());
        }
      });
      m.on('dragend', () => {
        persistMarker(m);
        if(m._meta?.type === 'lokpot' && m._meta?.potId) {
          const newLL = m.getLatLng();
          allLines.forEach(l => {
            if(l._meta?.potId === m._meta.potId) {
              l._meta.pot = { lat: newLL.lat, lng: newLL.lng, id: m._meta.potId };
              persistLine(l);
            }
          });
        }
      });
    }
    allMarkers.push(m); markersGroup.addLayer(m); attachMarkerPopup(m);
  } else {
    m.setLatLng([doc.lat, doc.lng]);
    m._meta.type = doc.type;
    m._meta.potId = doc.potId||null;
    m._meta.date = doc.date||null;
    m._meta.by = doc.by||null;
    m._meta.aantal = (doc.aantal!=null ? doc.aantal : null);
    m._meta.note = doc.note||'';
    m._meta.sender = doc.sender||null;
    m._meta.nesttype = doc.nesttype||null;
    m._meta.ruimer = doc.ruimer||null;
    m._meta.methode = doc.methode||null;
    m._meta.succes = doc.succes||null;
    m._meta.valtype = doc.valtype||null;
    m._meta.koninginnen = doc.koninginnen!=null ? doc.koninginnen : null;
    m._meta.source = doc.source||null;
    m._meta.externalId = doc.externalId||null;
    m._meta.gbifKey = doc.gbifKey||null;
    m._meta.gbifDataset = doc.gbifDataset||null;
    m._meta.gbifLocality = doc.gbifLocality||null;
    m._meta.gbifBehavior = doc.gbifBehavior||null;
    m._meta.gbifLifestage = doc.gbifLifestage||null;
    m._meta.gbifSex = doc.gbifSex||null;
    m._meta.gbifBasis = doc.gbifBasis||null;
    m._meta.gbifIssues = doc.gbifIssues||null;
    m._meta.gbifUrl = doc.gbifUrl||null;
    m._meta.gbifCoordPrec = doc.gbifCoordPrec||null;
    m._meta.gbifCoordUncertainty = doc.gbifCoordUncertainty||null;
    m._meta.gbifCoordJittered = doc.gbifCoordJittered||false;
    m._meta.gbifCountry = doc.gbifCountry||null;
    m._meta.validationStatus = doc.validationStatus||null;
    m._meta.permalink = doc.permalink||null;
    m._meta.location = doc.location||null;
    m.setIcon(getIconForMarker(m._meta));
  }
  attachMarkerPopup(m);
  applyFilters();
}
function deleteMarkerFromCloudLocal(id){
  const m = allMarkers.find(x=>x._meta?.id===id);
  if(m){ deleteMarkerAndAssociations(m); }
}
function upsertLineFromCloud(doc){
  let l = allLines.find(x=>x._meta?.id===doc.id);
  const latlngs = (doc.latlngs||[]).map(p=>L.latLng(p.lat,p.lng));
  if(!l){
    l = L.polyline(latlngs,{color:(doc.color||'#ffcc00'),weight:3}).addTo(linesGroup);
    l._meta = { ...doc };
    registerLine(l);
    const _ll = l.getLatLngs(); const _endPt = _ll[_ll.length-1];
    l._distLabel = L.tooltip({permanent:true,direction:'right',offset:[8,0],className:'line-label'})
      .setContent(`${doc.distance||0} m`)
      .setLatLng(_endPt)
      .addTo(map);
    attachSightLineInteractivity(l);
  } else {
    l.setLatLngs(latlngs);
    l._meta = { ...l._meta, ...doc };
    if(l._distLabel){ const _ull=l.getLatLngs(); l._distLabel.setContent(`${doc.distance||0} m`).setLatLng(_ull[_ull.length-1]); }
  }
  applyFilters();
}
function deleteLineFromCloudLocal(id){
  const l = allLines.find(x=>x._meta?.id===id);
  if(l) deleteSightLine(l,false);
}
function upsertSectorFromCloud(doc){
  const line = allLines.find(l=>l._meta?.id===doc.flightId);
  if(line && line._sector){ circlesGroup.removeLayer(line._sector); }
  const sector = createSectorLayer({
    id: doc.id, pot: doc.pot, distance: doc.distance, color: doc.color, bearing: doc.bearing,
    rInner: doc.rInner, rOuter: doc.rOuter, angleLeft: doc.angleLeft, angleRight: doc.angleRight, steps: doc.steps, flightId: doc.flightId
  }).addTo(circlesGroup);
  registerSector(sector);
  if(line){ line._sector = sector; sector._line = line; }
  applyFilters();
}
function deleteSectorFromCloudLocal(id){
  const s = allSectors.find(x=>x._meta?.id===id);
  if(s){ circlesGroup.removeLayer(s); }
}
function upsertPolygonFromCloud(doc){
  let p = polygonsGroup.getLayers().find(x=>x._props?.id===doc.id);
  if(p){ if(p._labelTooltip){ try{map.removeLayer(p._labelTooltip);}catch{} p._labelTooltip=null; } polygonsGroup.removeLayer(p); }
  const latlngs = (doc.latlngs||[]).map(pt=>L.latLng(pt.lat,pt.lng));
  const lp = L.polygon(latlngs).addTo(polygonsGroup);
  // Label altijd opslaan — refreshPolygonLabel bepaalt zichtbaarheid op basis van actief gebied
  lp._props = { id: doc.id, label: doc.label||'', color: doc.color||'#0aa879', zoneId: doc.zoneId||'' };
  initPolygon(lp);
}
function _removePolygonLayer(p){
  if(!p) return;
  if(p._labelTooltip){ try{ map.removeLayer(p._labelTooltip); }catch{} p._labelTooltip = null; }
  polygonsGroup.removeLayer(p);
}
function deletePolygonFromCloudLocal(id){
  const p = polygonsGroup.getLayers().find(x=>x._props?.id===id);
  _removePolygonLayer(p);
}
// ======================= Scope & opstart =======================
const LS_SCOPE = "hornet_scope_v610"; // {year, group}
const DEFAULT_YEAR = String(new Date().getFullYear());
const DEFAULT_GROUP = "Zeist";

// Zones: interne sleutel → weergavenaam + kaartcentrum
const ZONE_META = {
  'Zeist':       { label: 'Zeist',       lat: 52.0893, lon: 5.2425, zoom: 13 },
  'Bilthoven':   { label: 'Bilthoven',   lat: 52.1267, lon: 5.1986, zoom: 13 },
  'Driebergen':  { label: 'Driebergen',  lat: 52.0561, lon: 5.2867, zoom: 13 },
  'Utrecht':     { label: 'Utrecht',     lat: 52.0907, lon: 5.1214, zoom: 13 },
};
// Achterwaartse compatibiliteit: oude sleutels met Hoornaar_ prefix
const ZONE_ALIAS = {
  'Hoornaar_Zeist':      'Zeist',
  'Hoornaar_Bilthoven':  'Bilthoven',
  'Hoornaar_Driebergen': 'Driebergen',
  'Hoornaar_Utrecht':    'Utrecht',
};
function normalizeZone(z) { return ZONE_ALIAS[z] || z; }
function zoomToZone(zone) {
  const z = normalizeZone(zone);
  const meta = ZONE_META[z];
  if (meta && map) map.flyTo([meta.lat, meta.lon], meta.zoom, { duration: 1 });
}
const ROL_LABEL = {
  admin:     '🔑 Admin',
  manager:   '🛠 Beheerder',
  volunteer: '👷 Vrijwilliger',
  pending:   '⏳ In afwachting',
};
function updateHeaderScope(zone, year) {
  const label = ZONE_META[normalizeZone(zone)]?.label || zone;
  const el = document.getElementById('hdr-scope');
  const wrap = document.getElementById('hdr-scope-wrap');
  if (el) el.textContent = `${label} (${year || DEFAULT_YEAR})`;
  if (wrap) wrap.classList.remove('hidden');
  // Statusbalk mobiel
  const sbScope = document.getElementById('sb-scope');
  if (sbScope) sbScope.textContent = `${label} ${year || DEFAULT_YEAR}`;
  _updateStatusbar();
}
function updateHeaderRole(role, name) {
  // Rol in header tonen
  const el = document.getElementById('hdr-role');
  if (el) el.textContent = ROL_LABEL[role] || role;
  // Naam in sidebar tonen (id=hdr-user)
  const sidebarName = document.getElementById('hdr-user');
  const sidebarBlock = document.getElementById('sidebar-userblock');
  const displayName = name || _currentDisplayName || auth.currentUser?.displayName || auth.currentUser?.email || '';
  if (sidebarName && displayName) {
    sidebarName.textContent = displayName;
    if (sidebarBlock) sidebarBlock.style.display = '';
  }
  // Statusbalk mobiel
  const sbRole = document.getElementById('sb-role');
  if (sbRole) sbRole.textContent = ROL_LABEL[role] || role;
  _updateStatusbar();
}
function _updateStatusbar() {
  const bar = document.getElementById('hdr-statusbar');
  if (!bar) return;
  // Alleen tonen op mobiel én als ingelogd met rol
  if (window.innerWidth <= 540 && _currentRole && _currentRole !== 'pending') {
    bar.classList.add('visible');
  } else {
    bar.classList.remove('visible');
  }
}
function readScope(){ try{ return JSON.parse(localStorage.getItem(LS_SCOPE))||null; }catch{return null;} }
function writeScope(year, group){ localStorage.setItem(LS_SCOPE, JSON.stringify({year,group})); }
function activateScope(year, group, reload=false){
  const { base } = setActiveScope(year, group);
  writeScope(year, group);
  listenToCloudChanges({
    onMarkerUpdate: upsertMarkerFromCloud,
    onMarkerDelete: deleteMarkerFromCloudLocal,
    onLineUpdate: upsertLineFromCloud,
    onLineDelete: deleteLineFromCloudLocal,
    onSectorUpdate: upsertSectorFromCloud,
    onSectorDelete: deleteSectorFromCloudLocal,
    onPolygonUpdate: upsertPolygonFromCloud,
    onPolygonDelete: deletePolygonFromCloudLocal
  });
  if(reload){
    // Eerst polygon labels verwijderen (zijn losse tooltips op de map)
    polygonsGroup.getLayers().forEach(layer => {
      if(layer._labelTooltip){ try{ map.removeLayer(layer._labelTooltip); }catch{} layer._labelTooltip = null; }
    });
    markersGroup.clearLayers(); linesGroup.clearLayers(); circlesGroup.clearLayers(); handlesGroup.clearLayers(); polygonsGroup.clearLayers();
    allLines.forEach(l=>{ if(l._distLabel){ try{map.removeLayer(l._distLabel);}catch{} } });
  allMarkers=[]; allLines=[]; allSectors=[];
  }
  setStatus(statusSW, `Scope: ${base}`, 'ok');
  zoomToZone(group);
  updateHeaderScope(group, year);
}
// ======================= DOMContentLoaded: alles starten =======================
function boot(){
  initMap();
  initUIBindings();
  const selYear = $('sel-year');
  const saved = readScope() || { year: DEFAULT_YEAR, group: DEFAULT_GROUP };
  // Jaar dropdown vullen: 2020 t/m huidig jaar (nieuwste bovenaan)
  if(selYear){
    selYear.innerHTML = '';
    const curY = new Date().getFullYear();
    for(let y = curY; y >= 2020; y--){
      const opt = document.createElement('option');
      opt.value = String(y); opt.textContent = String(y);
      selYear.appendChild(opt);
    }
    selYear.value = saved.year;
    if(!selYear.value) selYear.value = DEFAULT_YEAR;
  }
  // sel-group NIET als vaste variabele opslaan: _fillZoneDropdown() vervangt het element later
  const getSelGroup = () => $('sel-group');
  const getSelYear  = () => $('sel-year');
  if(getSelGroup()) getSelGroup().value = saved.group;

  // Fix 103: auto-wissel bij wijziging jaar of gebied (geen Toepassen-knop meer nodig)
  function _doScopeChange() {
    const y = getSelYear()?.value || DEFAULT_YEAR;
    const g = getSelGroup()?.value || DEFAULT_GROUP;
    activateScope(y, g, /*reload=*/true);
    window._setSidebar?.(false);
  }
  // jaar: change event op het select element
  if(selYear) selYear.addEventListener('change', _doScopeChange);
  // gebied: change event, ook na _fillZoneDropdown (delegeer via document)
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'sel-group') _doScopeChange();
  });
  // apply-scope knop: nog steeds beschikbaar als fallback maar verbergen
  const applyBtn = $('apply-scope');
  if (applyBtn) applyBtn.style.display = 'none';
  activateScope(saved.year, saved.group, /*reload=*/true);
  applyFilters();
  // Roles doc controleren: aanmaken als pending bij eerste login, daarna displayName + zones laden
  _initUserRole();
  _loadZoneManagers();
}

// Laad alle managers uit roles collectie en bouw zone→naam map
async function _loadZoneManagers() {
  try {
    const snap = await getDocs(collection(_db, 'roles'));
    snap.forEach(d => {
      const data = d.data();
      if (data.role === 'manager' && Array.isArray(data.zones)) {
        data.zones.forEach(z => {
          const norm = normalizeZone(z);
          if (norm && !_zoneManagers[norm]) {
            _zoneManagers[norm] = data.displayName || data.email || '?';
          }
        });
      }
    });
    console.log('[app] zone managers geladen:', _zoneManagers);
  } catch(e) {
    console.warn('[app] _loadZoneManagers fout:', e);
  }
}

// ======================= Overzicht rapport =======================
let _reportDays = 7; // huidig geselecteerd aantal dagen

// Punt-in-polygoon check (ray casting)
function pointInPolygon(lat, lng, latlngs) {
  let inside = false;
  const x = lng, y = lat;
  for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
    const xi = latlngs[i].lng, yi = latlngs[i].lat;
    const xj = latlngs[j].lng, yj = latlngs[j].lat;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function emptyCount() { return { waarnemingen:0, lokpotten:0, nesten:0, geruimd:0, vallen:0 }; }
function addCount(c, type) {
  if (type==='hoornaar') c.waarnemingen++;
  else if (type==='lokpot') c.lokpotten++;
  else if (type==='nest') c.nesten++;
  else if (type==='nest_geruimd') c.geruimd++;
  else if (type==='val') c.vallen++;
}
function rowTotal(c) { return c.waarnemingen+c.lokpotten+c.nesten+c.geruimd+c.vallen; }

function renderCountCells(c) {
  const v = (n, col) => '<td style="text-align:center;padding:3px 4px;color:' + (n?col:'#cbd5e1') + '">' + (n||'\u2013') + '</td>';
  return v(c.waarnemingen,'#cc2222') + v(c.lokpotten,'#2d6b50') + v(c.nesten,'#334466') + v(c.geruimd,'#1a7a40') + v(c.vallen,'#8b6030');
}

async function loadReport(days, targetId = 'report-content', excludeGbif = false, reportYear = null) {
  _reportDays = days;
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = '<span style="color:#94a3b8">Laden...</span>';

  try {
    const year = reportYear || $('sel-year')?.value || DEFAULT_YEAR;
    // Admin ziet alle zones, manager/volunteer alleen eigen toegewezen zones
    const zones = (_currentRole === 'admin')
      ? Object.keys(ZONE_META)
      : _currentZones.filter(z => ZONE_META[z]);
    const dateFrom = getDateFrom(days);
    const isToday = days === 'today';
    const todayStr = new Date().toISOString().slice(0,10);

    const periodLabel = isToday ? 'vandaag'
      : days===7?'afgelopen week':days===14?'afgelopen 2 weken'
      : days===30?'afgelopen maand':days===365?'afgelopen jaar':`afgelopen ${days} dagen`;

    let html = `<div style="color:#64748b;font-size:11px;margin-bottom:8px">${periodLabel}</div>`;

    const HDR = `<table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="border-bottom:2px solid #e2e8f0;color:#94a3b8">
        <th style="text-align:left;padding:3px 4px">Gebied / Polygoon</th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Waarneming — hoornaar gezien"><span style="font-size:15px">🐝</span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Lokpot geplaatst"><span style="font-size:15px">🪤</span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Nest gevonden"><span style="font-size:15px">🪹</span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Nest geruimd"><span style="font-size:15px">✅</span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Val geplaatst"><span style="font-size:15px">🪝</span></th>
      </tr></thead><tbody>`;

    let totAll = emptyCount();
    let anyData = false;

    for (const zone of zones) {
      const base = 'maps/' + year + '/' + zone + '/data';

      // Polygonen en markers parallel ophalen
      const [markerSnap, polySnap] = await Promise.all([
        getDocs(collection(_db, base, 'markers')),
        getDocs(collection(_db, base, 'polygons'))
      ]);

      // Markers filteren op periode en optioneel GBIF uitsluiten
      const markers = [];
      markerSnap.forEach(d => {
        const data = d.data();
        if (excludeGbif && data.source === 'GBIF') return;
        if (isToday) {
          if (!data.date || data.date !== todayStr) return;
        } else if (dateFrom && data.date && data.date < dateFrom) return;
        markers.push(data);
      });

      // Polygonen opbouwen
      const polys = [];
      polySnap.forEach(d => {
        const data = d.data();
        if (data.latlngs && data.latlngs.length > 2) {
          polys.push({ label: data.label || '(geen naam)', latlngs: data.latlngs, count: emptyCount() });
        }
      });
      const zoneCount = emptyCount();
      const outsideCount = emptyCount(); // markers buiten alle polygonen

      // Markers toewijzen aan polygoon of 'buiten'
      markers.forEach(m => {
        let matched = false;
        for (const poly of polys) {
          if (pointInPolygon(m.lat, m.lng, poly.latlngs)) {
            addCount(poly.count, m.type);
            matched = true;
            break;
          }
        }
        if (!matched) addCount(outsideCount, m.type);
        addCount(zoneCount, m.type);
      });

      if (rowTotal(zoneCount) === 0 && polys.length === 0) continue;
      anyData = true;

      // Zone kopregel
      html += `<tr style="background:#f1f5f9">
        <td colspan="6" style="padding:5px 4px;font-weight:700;color:#1e293b;font-size:12px">${zone}</td>
      </tr>`;

      // Polygoon rijen
      polys.forEach(poly => {
        if (rowTotal(poly.count) === 0) return; // skip lege polygonen
        html += `<tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:3px 4px 3px 12px;color:#475569">↳ ${poly.label}</td>
          ${renderCountCells(poly.count)}
        </tr>`;
      });

      // Buiten polygonen (indien van toepassing)
      if (rowTotal(outsideCount) > 0) {
        html += `<tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:3px 4px 3px 12px;color:#94a3b8;font-style:italic">↳ buiten polygonen</td>
          ${renderCountCells(outsideCount)}
        </tr>`;
      }

      // Zone subtotaal
      html += `<tr style="border-bottom:2px solid #e2e8f0">
        <td style="padding:3px 4px;color:#64748b;font-size:11px">totaal ${zone}</td>
        ${renderCountCells(zoneCount)}
      </tr>`;

      // Optellen bij eindtotaal
      totAll.waarnemingen+=zoneCount.waarnemingen; totAll.lokpotten+=zoneCount.lokpotten;
      totAll.nesten+=zoneCount.nesten; totAll.geruimd+=zoneCount.geruimd; totAll.vallen+=zoneCount.vallen;
    }

    if (!anyData) {
      el.innerHTML = '<span style="color:#94a3b8;font-size:12px">Geen gegevens in deze periode.</span>';
      return;
    }

    html += `<tr style="font-weight:700;color:#1e293b;background:#f8fafc">
      <td style="padding:5px 4px">Totaal</td>
      ${renderCountCells(totAll)}
    </tr>`;
    html += '</tbody></table>';
    el.innerHTML = HDR + html;

  } catch(e) {
    console.warn('[rapport] fout:', e);
    el.innerHTML = '<span style="color:#ef4444;font-size:12px">Laden mislukt: ' + e.message + '</span>';
  }
}

function initReportSection() {
  // Fix 102: overzicht verplaatst naar beheer scherm (modal tab)
  const section = document.getElementById('report-section');
  if (section) section.style.display = 'none';
  // Custom event listener zodat admin.js loadReport kan aanroepen via modal
  window.addEventListener('hornet:loadReport', (e) => {
    const { days, targetId, excludeGbif, year } = e.detail || {};
    loadReport(days || 7, targetId || 'report-content-modal', !!excludeGbif, year || null);
  });
}

async function _initUserRole() {
  try {
    const uid   = auth.currentUser?.uid;
    const email = auth.currentUser?.email;
    if (!uid) return;

    const ref  = doc(_db, 'roles', uid);
    let snap = await getDoc(ref);

    if (!snap.exists()) {
      // Eerste login — pending aanmaken zodat admin hem kan accepteren
      console.log('[app] nieuw account, pending aanmaken voor', email);
      await setDoc(ref, {
        role:        'pending',
        email:       email || '',
        displayName: auth.currentUser?.displayName || '',
        createdAt:   new Date().toISOString(),
      });
      // Opnieuw ophalen ter verificatie
      snap = await getDoc(ref);
      if (!snap.exists()) {
        console.error('[app] pending aanmaken mislukt — doc bestaat nog steeds niet');
        _showPendingScreen(email);
        return;
      }
      console.log('[app] pending aangemaakt en geverifieerd voor', email);
    }

    const data = snap.data();

    // ── PENDING: kaart blokkeren, pending scherm tonen ──────────────────────
    if (!data?.role || data.role === 'pending') {
      console.log('[app] rol is pending — kaart blokkeren');
      _showPendingScreen(email);
      return; // stop hier — geen kaart laden
    }

    // displayName laden
    if (data?.displayName) {
      _currentDisplayName = data.displayName;
    }
    // Rol en zones opslaan
    _currentRole  = data?.role || '';
    updateHeaderRole(_currentRole, data?.displayName || auth.currentUser?.displayName || '');
    const rawZones = Array.isArray(data?.zones) ? data.zones : [];
    _currentZones = rawZones.map(normalizeZone).filter(z => ZONE_META[z]);

    // Beheer knop tonen voor admin, manager en volunteer (Fix 102)
    if (_currentRole === 'admin' || _currentRole === 'manager' || _currentRole === 'volunteer') {
      $('btn-admin')?.classList.remove('hidden');
    }
    // Geoman tekenen: alleen tonen voor admin en manager
    if (!canEdit()) {
      try { map.pm.addControls({ drawRectangle:false, drawPolygon:false, editMode:false, dragMode:false, removalMode:false, rotateMode:false, position:'topleft' }); } catch{}
    }
    // Overzicht rapport tonen (admin/manager)
    initReportSection();

    // Zones laden en dropdown vullen, daarna scope activeren
    if (_currentZones.length) {
      const activeZone = _fillZoneDropdown(_currentZones);
      const year = $('sel-year')?.value || DEFAULT_YEAR;
      activateScope(year, activeZone, /*reload=*/true);
    }

  } catch (e) {
    console.warn('[app] _initUserRole mislukt:', e.message);
    // Bij netwerk/permission fout: toon pending scherm als veilige fallback
    _showPendingScreen(auth.currentUser?.email);
  }
}

function _showPendingScreen(email) {
  // Kaart verbergen, pending scherm tonen via main.js functie
  document.getElementById('app-shell')?.classList.add('hidden');
  document.getElementById('pending-screen')?.classList.remove('hidden');
  const emailEl = document.getElementById('pending-email');
  if(emailEl) emailEl.textContent = email ? `Ingelogd als: ${email}` : '';
}

function _fillZoneDropdown(zones) {
  const sel = $('sel-group');
  if (!sel) return;
  // Vervang input+datalist door een select met alleen de toegestane zones
  const parent = sel.parentElement;
  // Verwijder oude datalist indien aanwezig
  document.getElementById('groups')?.remove();
  // Bouw nieuwe select
  const newSel = document.createElement('select');
  newSel.id = 'sel-group';
  newSel.className = sel.className || '';
  zones.forEach(z => {
    const opt = document.createElement('option');
    opt.value = z;
    opt.textContent = ZONE_META[z]?.label || z;
    newSel.appendChild(opt);
  });
  sel.replaceWith(newSel);
  // Herstel opgeslagen keuze indien die in de lijst staat, anders eerste zone
  const saved = readScope();
  const savedNorm = saved?.group ? normalizeZone(saved.group) : null;
  const activeZone = (savedNorm && zones.includes(savedNorm)) ? savedNorm : zones[0];
  newSel.value = activeZone;
  console.log('[app] zone dropdown gevuld:', zones, '→ actief:', activeZone);
  return activeZone;  // teruggeven zodat aanroeper scope kan activeren
}

export { boot };
