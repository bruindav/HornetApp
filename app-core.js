// app-core.js — Fix 88
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
const SOFT_MS=150, HARD_MS=300; let DEBOUNCE_MS=SOFT_MS;
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

  // Icoon grootte aanpassen bij zoom
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
  on(req('toggle-sidebar'), 'click', ()=>{
    const willOpen = document.body.classList.contains('sidebar-collapsed');
    setSidebar(willOpen); // als dicht → open; als open → dicht
  });
  on(backdrop, 'click', ()=> setSidebar(false));
  // Init: op mobiel standaard dicht
  if (window.matchMedia('(max-width: 900px)').matches) setSidebar(false);

  // Harde debounce
  on(req('hard-debounce'),'change', e=>{
    DEBOUNCE_MS = e.target.checked ? HARD_MS : SOFT_MS;
  });
  // Filters
  on(req('apply-filters'), 'click', applyFilters);
  // Live update bij checkbox wijziging
  ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_pending','f_poly_outline'].forEach(id => {
    const el = $(id); if(el) el.addEventListener('change', applyFilters);
  });
  on(req('reset-filters'), 'click', ()=>{
    ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_pending']
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
        console.log('[app] openAdminOverlay geïmporteerd, aanroepen...');
        await openAdminOverlay();
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
// Periode-slider stappen (index 0 = alles, 1..6 = steeds verder terug)
const PERIOD_STEPS = [
  { label: 'Alles',         days: null },
  { label: 'Deze week',     days: 7    },
  { label: '2 weken',       days: 14   },
  { label: '3 weken',       days: 21   },
  { label: 'Maand',         days: 30   },
  { label: 'Half jaar',     days: 183  },
  { label: 'Jaar',          days: 365  },
];
function getDateFrom(days){
  if(!days) return null;
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

// SVG iconen — gebaseerd op illustratie (hoornaar, nest, nest geruimd, lokpot)
const SVG = {
  hornet_full:        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="22" height="22"><!-- Vleugels --><ellipse cx="17" cy="10" rx="9" ry="4" fill="rgba(210,230,255,0.75)" stroke="#666" stroke-width="0.6" transform="rotate(-20,17,10)"/><ellipse cx="17" cy="14" rx="7" ry="3" fill="rgba(210,230,255,0.6)" stroke="#666" stroke-width="0.5" transform="rotate(10,17,14)"/><!-- Lijf segmenten geel/zwart --><ellipse cx="14" cy="17" rx="6" ry="4" fill="#f5c800" stroke="#1a0a00" stroke-width="0.8"/><rect x="9" y="15" width="3.5" height="4" rx="1" fill="#1a0a00" opacity="0.85"/><rect x="13.5" y="15" width="3" height="4" rx="1" fill="#1a0a00" opacity="0.85"/><rect x="17" y="15" width="2.5" height="4" rx="1" fill="#1a0a00" opacity="0.75"/><!-- Achterlijf punt --><path d="M20 17 Q24 17 25 19 Q24 21 20 19 Z" fill="#f5c800" stroke="#1a0a00" stroke-width="0.7"/><!-- Kop --><circle cx="9" cy="16" r="3.5" fill="#1a0a00"/><!-- Oog --><ellipse cx="8" cy="15" rx="1.5" ry="1.8" fill="#f5c800"/><circle cx="8" cy="15" r="0.8" fill="#1a0a00"/><!-- Antennes --><path d="M9 13 Q7 9 5 7" stroke="#1a0a00" stroke-width="0.8" fill="none" stroke-linecap="round"/><path d="M10 13 Q10 8 9 6" stroke="#1a0a00" stroke-width="0.8" fill="none" stroke-linecap="round"/><!-- Poten --><path d="M12 20 Q10 23 8 25" stroke="#1a0a00" stroke-width="0.7" fill="none" stroke-linecap="round"/><path d="M14 21 Q13 24 12 26" stroke="#1a0a00" stroke-width="0.7" fill="none" stroke-linecap="round"/><path d="M16 21 Q16 24 15 26" stroke="#1a0a00" stroke-width="0.7" fill="none" stroke-linecap="round"/></svg>',
  hornet_small:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16"><ellipse cx="11" cy="7" rx="6" ry="2.5" fill="rgba(210,230,255,0.7)" stroke="#888" stroke-width="0.5" transform="rotate(-20,11,7)"/><ellipse cx="9" cy="11" rx="4.5" ry="3" fill="#f5c800" stroke="#1a0a00" stroke-width="0.7"/><rect x="5.5" y="9.5" width="2.5" height="3" rx="0.8" fill="#1a0a00" opacity="0.85"/><rect x="8.5" y="9.5" width="2" height="3" rx="0.8" fill="#1a0a00" opacity="0.8"/><path d="M13 11 Q16 11 17 12.5 Q16 14 13 12.5 Z" fill="#f5c800" stroke="#1a0a00" stroke-width="0.6"/><circle cx="6" cy="10.5" r="2.5" fill="#1a0a00"/><ellipse cx="5.2" cy="10" rx="1" ry="1.2" fill="#f5c800"/></svg>',
  nest_full:          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="22" height="22"><!-- Nest bol --><ellipse cx="16" cy="17" rx="12" ry="11" fill="#9e8e7a" stroke="#5a4a3a" stroke-width="1"/><!-- Textuur lijnen --><path d="M8 12 Q16 10 24 12" stroke="#7a6a5a" stroke-width="0.6" fill="none"/><path d="M6 16 Q16 14 26 16" stroke="#7a6a5a" stroke-width="0.6" fill="none"/><path d="M7 20 Q16 18 25 20" stroke="#7a6a5a" stroke-width="0.6" fill="none"/><path d="M9 24 Q16 22 23 24" stroke="#7a6a5a" stroke-width="0.6" fill="none"/><!-- Ingang opening --><ellipse cx="16" cy="17" rx="5" ry="4.5" fill="#2a1a0a" stroke="#1a0a00" stroke-width="0.8"/><ellipse cx="16" cy="17" rx="3.5" ry="3" fill="#0a0500"/><!-- Kleine hoornaar bovenop --><ellipse cx="16" cy="7" rx="3.5" ry="2" fill="#f5c800" stroke="#1a0a00" stroke-width="0.6"/><rect x="13.5" y="6" width="1.5" height="2" rx="0.5" fill="#1a0a00" opacity="0.8"/><rect x="15.5" y="6" width="1.5" height="2" rx="0.5" fill="#1a0a00" opacity="0.8"/><circle cx="12.5" cy="7" r="1.5" fill="#1a0a00"/><path d="M12.5 6 Q11 4 10 3" stroke="#1a0a00" stroke-width="0.6" fill="none"/><ellipse cx="18" cy="5.5" rx="3" ry="1.5" fill="rgba(210,230,255,0.7)" stroke="#666" stroke-width="0.4" transform="rotate(-15,18,5.5)"/></svg>',
  nest_small:         '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16"><ellipse cx="10" cy="11" rx="8.5" ry="7.5" fill="#9e8e7a" stroke="#5a4a3a" stroke-width="0.8"/><path d="M4 8 Q10 6 16 8" stroke="#7a6a5a" stroke-width="0.5" fill="none"/><path d="M3 12 Q10 10 17 12" stroke="#7a6a5a" stroke-width="0.5" fill="none"/><path d="M4 16 Q10 14 16 16" stroke="#7a6a5a" stroke-width="0.5" fill="none"/><ellipse cx="10" cy="11" rx="3.5" ry="3" fill="#2a1a0a" stroke="#1a0a00" stroke-width="0.7"/><ellipse cx="10" cy="11" rx="2" ry="1.8" fill="#0a0500"/></svg>',
  nest_geruimd_full:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="22" height="22"><!-- Nest bol (wat kleiner, ruimte voor kruis) --><ellipse cx="16" cy="18" rx="11" ry="10" fill="#9e8e7a" stroke="#5a4a3a" stroke-width="1"/><path d="M8 14 Q16 12 24 14" stroke="#7a6a5a" stroke-width="0.5" fill="none"/><path d="M6 18 Q16 16 26 18" stroke="#7a6a5a" stroke-width="0.5" fill="none"/><path d="M7 22 Q16 20 25 22" stroke="#7a6a5a" stroke-width="0.5" fill="none"/><!-- Ingang --><ellipse cx="16" cy="18" rx="4.5" ry="4" fill="#2a1a0a" stroke="#1a0a00" stroke-width="0.7"/><ellipse cx="16" cy="18" rx="3" ry="2.5" fill="#0a0500"/><!-- Rood kruis --><line x1="5" y1="5" x2="27" y2="27" stroke="#cc0000" stroke-width="3.5" stroke-linecap="round"/><line x1="27" y1="5" x2="5" y2="27" stroke="#cc0000" stroke-width="3.5" stroke-linecap="round"/><!-- Kruis rand --><line x1="5" y1="5" x2="27" y2="27" stroke="#ff4444" stroke-width="2" stroke-linecap="round"/><line x1="27" y1="5" x2="5" y2="27" stroke="#ff4444" stroke-width="2" stroke-linecap="round"/></svg>',
  nest_geruimd_small: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16"><ellipse cx="10" cy="12" rx="8" ry="7" fill="#9e8e7a" stroke="#5a4a3a" stroke-width="0.8"/><ellipse cx="10" cy="12" rx="3" ry="2.5" fill="#2a1a0a"/><line x1="3" y1="3" x2="17" y2="17" stroke="#cc0000" stroke-width="3" stroke-linecap="round"/><line x1="17" y1="3" x2="3" y2="17" stroke="#cc0000" stroke-width="3" stroke-linecap="round"/><line x1="3" y1="3" x2="17" y2="17" stroke="#ff5555" stroke-width="1.5" stroke-linecap="round"/><line x1="17" y1="3" x2="3" y2="17" stroke="#ff5555" stroke-width="1.5" stroke-linecap="round"/></svg>',
  lokpot_full:        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="22" height="22"><!-- Cilinder body --><rect x="9" y="14" width="14" height="14" rx="2" fill="#1a1a1a" stroke="#0a0a0a" stroke-width="0.8"/><!-- Geel deksel --><ellipse cx="16" cy="14" rx="7" ry="2.5" fill="#f5c800" stroke="#1a0a00" stroke-width="0.8"/><ellipse cx="16" cy="12.5" rx="7" ry="2.5" fill="#f5c800" stroke="#1a0a00" stroke-width="0.8"/><!-- Deksel zijkant --><rect x="9" y="12.5" width="14" height="1.5" fill="#d4a800"/><!-- Hoornaar op deksel --><ellipse cx="16" cy="10" rx="4" ry="2.2" fill="#f5c800" stroke="#1a0a00" stroke-width="0.6"/><rect x="13.5" y="9" width="1.8" height="2.2" rx="0.5" fill="#1a0a00" opacity="0.8"/><rect x="15.8" y="9" width="1.8" height="2.2" rx="0.5" fill="#1a0a00" opacity="0.8"/><circle cx="12.5" cy="10" r="1.8" fill="#1a0a00"/><ellipse cx="8.5" cy="8" rx="4" ry="1.8" fill="rgba(210,230,255,0.75)" stroke="#666" stroke-width="0.4" transform="rotate(-15,8.5,8)"/><path d="M12 9 Q10 6 9 5" stroke="#1a0a00" stroke-width="0.7" fill="none"/><path d="M13 9 Q12 6 11 5" stroke="#1a0a00" stroke-width="0.7" fill="none"/><!-- Cilinder basis --><ellipse cx="16" cy="28" rx="7" ry="2" fill="#111" stroke="#0a0a0a" stroke-width="0.5"/><!-- Ventilatiesleuven --><line x1="11" y1="18" x2="21" y2="18" stroke="#333" stroke-width="0.8"/><line x1="11" y1="21" x2="21" y2="21" stroke="#333" stroke-width="0.8"/><line x1="11" y1="24" x2="21" y2="24" stroke="#333" stroke-width="0.8"/></svg>',
  lokpot_small:       '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16"><rect x="6" y="10" width="10" height="9" rx="1.5" fill="#1a1a1a" stroke="#0a0a0a" stroke-width="0.6"/><ellipse cx="11" cy="10" rx="5" ry="1.8" fill="#f5c800" stroke="#1a0a00" stroke-width="0.7"/><ellipse cx="11" cy="8.5" rx="5" ry="1.8" fill="#f5c800" stroke="#1a0a00" stroke-width="0.7"/><rect x="6" y="8.5" width="10" height="1.5" fill="#d4a800"/><ellipse cx="11" cy="19" rx="5" ry="1.5" fill="#111"/></svg>',
};

function makeDivIcon(svgHtml, bg, border, size){
  bg     = bg     || '#1e293b';
  border = border || '#334155';
  size   = size   || 'full';
  if(size === 'full'){
    return L.divIcon({
      className:'custom-div-icon',
      html:'<div style="background:'+bg+';color:#fff;border:2px solid '+border+';border-radius:12px;padding:3px 5px;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;gap:3px">'+svgHtml+'</div>',
      iconSize:[36,30], iconAnchor:[18,15]
    });
  } else {
    return L.divIcon({
      className:'custom-div-icon',
      html:'<div style="background:'+bg+';color:#fff;border:2px solid '+border+';border-radius:10px;padding:2px 4px;box-shadow:0 1px 4px rgba(0,0,0,.3);display:flex;align-items:center">'+svgHtml+'</div>',
      iconSize:[26,24], iconAnchor:[13,12]
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
      ? SVG.hornet_full + (a ? '<span style="font-size:11px;font-weight:700;color:#fff">\xD7'+a+'</span>' : '')
      : SVG.hornet_small,
    '#8b1a1a','#cc2222',sz),
  nest:(sz='full')=>makeDivIcon(
    sz==='full' ? SVG.nest_full          : SVG.nest_small,
    '#3a3a2a','#6a5a3a',sz),
  nest_geruimd:(sz='full')=>makeDivIcon(
    sz==='full' ? SVG.nest_geruimd_full  : SVG.nest_geruimd_small,
    '#1a3a2a','#2d6a4a',sz),
  lokpot:(sz='full')=>makeDivIcon(
    sz==='full' ? SVG.lokpot_full        : SVG.lokpot_small,
    '#1a1a0a','#3a3a1a',sz),
  pending:(sz='full')=>makeDivIcon(sz==='full'?'\u23F3':'\u23F3','#555','#777',sz),
};
// Stip-iconen: kleur + één letter als herkenbaarheid
const DOTS = {
  hoornaar: (sz)=>makeDotIcon('#cc2222', (sz===true||sz==='micro')?'':'W', sz==='micro'?5:sz===true?8:13),
  nest:     (sz)=>makeDotIcon('#334466', (sz===true||sz==='micro')?'':'N', sz==='micro'?5:sz===true?8:13),
  nest_geruimd:(sz)=>makeDotIcon('#1a7a40',(sz===true||sz==='micro')?'':'G', sz==='micro'?5:sz===true?8:13),
  lokpot:   (sz)=>makeDotIcon('#2d6b50', (sz===true||sz==='micro')?'':'L', sz==='micro'?5:sz===true?8:13),
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
  <button data-act="mk" data-type="hoornaar">🐝 Waarneming</button>
  <button data-act="mk" data-type="nest">🪹 Nest</button>
  <button data-act="mk" data-type="nest_geruimd">✅ Nest geruimd</button>
  <button data-act="mk" data-type="lokpot">🪤 Lokpot</button>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return;
    closeContextMenu();
    openPropModal({
      type:b.dataset.type,
      onSave:(vals)=>{
        const m = createMarkerWithPropsAt(latlng, b.dataset.type, vals);
        persistMarker(m);
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
        openPropModal({ type: marker._meta.type, init: marker._meta, onSave:(vals)=>{ applyPropsToMarker(marker, vals); persistMarker(marker); }});
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
function openPropModal({type, init={}, onSave}){
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
  const titles = { hoornaar:'🐝 Waarneming', nest:'🪹 Nest', nest_geruimd:'✅ Nest geruimd', lokpot:'🪤 Lokpot' };
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
  // Modal tonen
  modalEl2.classList.remove('hidden');
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
    onSave && onSave(vals); cleanup();
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
// ======================= Marker workflow =======================
function attachMarkerPopup(marker){
  const m=marker._meta||{};
  // Label per type
  const typeLabel = m.type==='hoornaar'?(m.aantal?`Waarneming (×${m.aantal})`:'Waarneming')
    :m.type==='nest'?'Nest':m.type==='nest_geruimd'?'Nest geruimd'
    :m.type==='lokpot'?'Lokpot':'Icoon';
  // Popup: alle velden netjes onder elkaar
  const row = (lbl,val) => `<div style="display:flex;gap:6px;margin-top:3px"><span style="color:#94a3b8;font-size:11px;min-width:56px">${lbl}</span><span style="font-size:12px;color:#1e293b">${val}</span></div>`;
  let popup = `<div style="min-width:160px"><strong style="font-size:13px">${typeLabel}</strong>`;
  if(m.date) popup += row('Datum', m.date);
  if(m.by)   popup += row('Door', m.by);
  if(m.type==='lokpot' && m.sender) popup += row('Zender', m.sender==='ja'?'✅ Ja':'❌ Nee');
  if(m.note) popup += `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #e2e8f0;font-size:12px;color:#374151;font-style:italic">${m.note}</div>`;
  popup += '</div>';
  marker.unbindPopup();
  marker.bindPopup(popup, {maxWidth:240});
  // Hover tooltip: alles onder elkaar als platte tekst
  marker.unbindTooltip();
  let tipLines = [typeLabel];
  if(m.date) tipLines.push(`Datum: ${m.date}`);
  if(m.by)   tipLines.push(`Door: ${m.by}`);
  if(m.type==='lokpot' && m.sender) tipLines.push(`Zender: ${m.sender==='ja'?'Ja':'Nee'}`);
  if(m.note) tipLines.push(m.note);
  marker.bindTooltip(tipLines.join('\n'), {direction:'top', offset:[0,-8], className:'marker-tip'});
}
function applyPropsToMarker(marker, vals){
  const m=marker._meta||{};
  if(vals.date) m.date=vals.date; else delete m.date;
  if(vals.by) m.by=vals.by; else delete m.by;
  if(vals.note!==undefined){ if(vals.note) m.note=vals.note; else delete m.note; }
  if(vals.sender!==undefined){ m.sender=vals.sender; }
  if(m.type==='hoornaar'){ if(vals.aantal!=null) m.aantal=vals.aantal; else delete m.aantal; }
  marker.setIcon(getIconForMarker(m));
  marker._meta=m; attachMarkerPopup(marker);
}
function placeMarkerAt(latlng, type='pending'){
  const id = genId('mk'); let marker;
  // Markers zijn NIET meer vrij draggable — verplaatsen gaat via contextmenu
  if(type==='lokpot'){ const potId=genId('pot'); marker=L.marker(latlng,{draggable:false}); marker._meta={id,type,potId}; }
  else { marker=L.marker(latlng,{draggable:false}); marker._meta={id,type:(type||'pending')}; }
  marker.setIcon(getIconForMarker(marker._meta));
  marker.on('contextmenu',e=>{
    e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation();
    if(shouldDebounce()) return;
    openMarkerContextMenu(marker, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
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
    potId:m.potId||null, note:m.note||null, sender:m.sender||null
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
    <button data-act="poly_delete">🗑️ Verwijderen</button>
    <hr/>`;
    } else {
      html += `<h4>Polygoon${_mgrTxt}</h4><hr/>`;
    }
  }
  if(canWrite()){
    html += `<h4>Nieuw icoon</h4>
    <button data-act="mk" data-type="hoornaar">🐝 Waarneming</button>
    <button data-act="mk" data-type="nest">🪹 Nest</button>
    <button data-act="mk" data-type="nest_geruimd">✅ Nest geruimd</button>
    <button data-act="mk" data-type="lokpot">🪤 Lokpot</button>`;
  }
  if(!html) return; // niets te tonen
  el.innerHTML=html;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    setTimeout(()=>{
      if(act==='mk'){ const m=createMarkerWithPropsAt(opts.latlng, b.dataset.type, {date:nowISODate()}); persistMarker(m); return; }
      if(!opts.polygonLayer) return;
      if(act==='poly_label'){ const lbl=prompt('Polygoon label:', opts.polygonLayer._props?.label||''); if(lbl===null) return; opts.polygonLayer._props.label=lbl; refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }
      else if(act==='poly_color'){ openColorModal(opts.polygonLayer._props?.color||'#0aa879', col=>{ opts.polygonLayer._props.color=col; opts.polygonLayer.setStyle({ color: col, fillColor: col }); refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }); }
      else if(act==='poly_edit'){ const enabled = opts.polygonLayer.pm?.enabled(); if(enabled) opts.polygonLayer.pm.disable(); else opts.polygonLayer.pm.enable(); }
      else if(act==='poly_delete'){ const id=opts.polygonLayer._props?.id; if(id){ deletePolygonFromCloud(id); } _removePolygonLayer(opts.polygonLayer); }
    },0);
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el, opts.x||0, opts.y||0);
  document.addEventListener('keydown', escClose); document.addEventListener('click', closeContextMenuOnce, true);
}
// ======================= Filters =======================
function getActiveFilters(){ return {
  hoornaar: !!$('f_type_hoornaar')?.checked,
  nest: !!$('f_type_nest')?.checked,
  nest_geruimd: !!$('f_type_nest_geruimd')?.checked,
  lokpot: !!$('f_type_lokpot')?.checked,
  pending: !!$('f_type_pending')?.checked,
  dateFrom: (()=>{
    const idx = parseInt($('f_period_slider')?.value||'0', 10);
    return getDateFrom((PERIOD_STEPS[idx]||PERIOD_STEPS[0]).days);
  })()
};}
function updatePeriodLabel(idx){
  const step = PERIOD_STEPS[idx] || PERIOD_STEPS[0];
  const lbl = $('f_period_label');
  if(lbl) lbl.textContent = step.label;
}

function applyFilters(){
  const f=getActiveFilters();
  allMarkers.forEach(m=>{
    const meta=m._meta||{}; let show=!!f[meta.type];
    if(f.dateFrom && meta.date){ if(meta.date < f.dateFrom) show=false; }
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
      // Bron metadata
      source: doc.source||null, externalId: doc.externalId||null,
      gbifKey: doc.gbifKey||null, gbifDataset: doc.gbifDataset||null,
      gbifLocality: doc.gbifLocality||null, gbifBehavior: doc.gbifBehavior||null,
      gbifLifestage: doc.gbifLifestage||null, gbifSex: doc.gbifSex||null,
      gbifBasis: doc.gbifBasis||null, gbifIssues: doc.gbifIssues||null,
      gbifUrl: doc.gbifUrl||null, gbifCoordPrec: doc.gbifCoordPrec||null,
      gbifCountry: doc.gbifCountry||null,
      // waarneming.nl CSV
      validationStatus: doc.validationStatus||null, permalink: doc.permalink||null,
      location: doc.location||null,
    };
    m.setIcon(getIconForMarker(m._meta));
    m.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(shouldDebounce()) return; openMarkerContextMenu(m, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
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
    allMarkers.push(m); markersGroup.addLayer(m);
  } else {
    m.setLatLng([doc.lat, doc.lng]);
    m._meta.type = doc.type;
    m._meta.potId = doc.potId||null;
    m._meta.date = doc.date||null;
    m._meta.by = doc.by||null;
    m._meta.aantal = (doc.aantal!=null ? doc.aantal : null);
    m._meta.note = doc.note||'';
    m._meta.sender = doc.sender||null;
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
  if(selYear && ![...selYear.options].some(o=>o.value===saved.year)){
    selYear.insertAdjacentHTML('afterbegin', `<option value="${saved.year}">${saved.year}</option>`);
  }
  if(selYear) selYear.value = saved.year;
  // sel-group NIET als vaste variabele opslaan: _fillZoneDropdown() vervangt het element later
  const getSelGroup = () => $('sel-group');
  const getSelYear  = () => $('sel-year');
  if(getSelGroup()) getSelGroup().value = saved.group;
  on(req('apply-scope'), 'click', ()=>{
    const y = getSelYear()?.value || DEFAULT_YEAR;
    const g = getSelGroup()?.value || DEFAULT_GROUP;
    activateScope(y, g, /*reload=*/true);
  });
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

function emptyCount() { return { waarnemingen:0, lokpotten:0, nesten:0, geruimd:0 }; }
function addCount(c, type) {
  if (type==='hoornaar') c.waarnemingen++;
  else if (type==='lokpot') c.lokpotten++;
  else if (type==='nest') c.nesten++;
  else if (type==='nest_geruimd') c.geruimd++;
}
function rowTotal(c) { return c.waarnemingen+c.lokpotten+c.nesten+c.geruimd; }

function renderCountCells(c) {
  const v = (n, col) => `<td style="text-align:center;padding:3px 4px;color:${n?col:'#cbd5e1'}">${n||'–'}</td>`;
  return v(c.waarnemingen,'#cc2222') + v(c.lokpotten,'#2d6b50') + v(c.nesten,'#334466') + v(c.geruimd,'#1a7a40');
}

async function loadReport(days) {
  _reportDays = days;
  const el = document.getElementById('report-content');
  if (!el) return;
  el.innerHTML = '<span style="color:#94a3b8">Laden...</span>';

  try {
    const year     = $('sel-year')?.value || DEFAULT_YEAR;
    // Admin ziet alle zones, manager/volunteer alleen eigen toegewezen zones
    const zones = (_currentRole === 'admin')
      ? Object.keys(ZONE_META)
      : _currentZones.filter(z => ZONE_META[z]);
    const dateFrom = getDateFrom(days);

    const periodLabel = days===7?'afgelopen week':days===14?'afgelopen 2 weken':days===30?'afgelopen maand':'afgelopen jaar';

    let html = `<div style="color:#64748b;font-size:11px;margin-bottom:8px">${periodLabel}</div>`;

    const HDR = `<table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="border-bottom:2px solid #e2e8f0;color:#94a3b8">
        <th style="text-align:left;padding:3px 4px">Gebied / Polygoon</th>
        <th style="text-align:center;padding:3px 4px" title="Waarnemingen">🐝</th>
        <th style="text-align:center;padding:3px 4px" title="Lokpotten">🪤</th>
        <th style="text-align:center;padding:3px 4px" title="Nesten">🪹</th>
        <th style="text-align:center;padding:3px 4px" title="Geruimd">✅</th>
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

      // Markers filteren op periode
      const markers = [];
      markerSnap.forEach(d => {
        const data = d.data();
        if (dateFrom && data.date && data.date < dateFrom) return;
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
        <td colspan="5" style="padding:5px 4px;font-weight:700;color:#1e293b;font-size:12px">${zone}</td>
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
      totAll.nesten+=zoneCount.nesten; totAll.geruimd+=zoneCount.geruimd;
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
  const section = document.getElementById('report-section');
  if (!section) return;
  // Tonen voor admin, manager en volunteer
  if (_currentRole !== 'admin' && _currentRole !== 'manager' && _currentRole !== 'volunteer') return;
  section.style.display = 'block';

  // Periode knoppen
  section.querySelectorAll('.rpt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      section.querySelectorAll('.rpt-btn').forEach(b => {
        b.style.background = '#fff'; b.style.color = '#1e293b';
      });
      btn.style.background = '#0aa879'; btn.style.color = '#fff';
      loadReport(parseInt(btn.dataset.days, 10));
    });
  });

  // Eerste load
  loadReport(_reportDays);
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

    // Beheer knop tonen als admin
    if (_currentRole === 'admin') {
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
