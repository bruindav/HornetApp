// app-core.js — Fix 91
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
  ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_val','f_type_pending','f_poly_outline'].forEach(id => {
    const el = $(id); if(el) el.addEventListener('change', applyFilters);
  });
  on(req('reset-filters'), 'click', ()=>{
    ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_val','f_type_pending']
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

// Icoon afbeeldingen — base64 PNG gebaseerd op gebruikersiconen
const IMG = {
  hoornaar_full:  '<img src="data:image/png;base64,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" width="27" height="32" style="display:inline-block;vertical-align:middle">',
  hoornaar_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAUCAYAAABroNZJAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAEZElEQVR42mVUWWxUVRj+zj33znJn5t5Z2plON4rdgBZamEJhEBsJ9KHGCphxYQsYgaACPhAxwXgDMYIJGAmmMQEkICIwWpRgVEJBkAdkSURMIYWuQO0+nWmnc2fmzj0+QAeE7+0s//cv5zsfwWNwy+ZNqkxAL44n2eDyvMrzrwWDKQAcAAaAvTK7dKpO9HKR4/7VQ/RasLl5FABJMygPLwMAV1uV758/NSegKMr4HuaV5fsXVE6oq/eX2vAU0iyfveWymZmxesPB7iYCsOoS9zQ1mZg2EB7+3WN3lVAqaFfv9FwEgD2rMv2jqrV167H2XgYQDgAYAxnLG4zKZqYeeidrHgAYCQrsDs+eDG/xJc4s/2gUhCoA2L8xt1wyM0eG1D7EAEIAlq6EMRBCwBq3ZK33TU6dmfteKCe3uORlwpsH42pUHe4LnW3cjL7OQazuiNq+2LT3bjw9zHRfj+jaeodP7z0eWxpLCXdDAwOtMTU6cehex8m23t6ehp8Ty9seJC5u2ns3riiPY/+H8QNJMhZWTXS+Wlleetg/Z3Z3YXZ23uTcrBdyMu0VABAIgD4Zl14EAqANDdA/rLNVyzYp4jaytT1REgyPxG60dnU1+bKFLU6TfnPJTGPO/lPx+08+CjeePRhE6uhG52JJJD49mqrTNG3SUDR0eXqR+/iJAKjFoPECFVYKBpR8t8G14pF2oCjgCAAogSmGXOegPzam+jZ+E969rNr9FwPbfvTP5HVAigDJ+MIydbrbwn997kr+9C0rWgOiyCeKsywnX9zWqZLdS91TBRMKjYwNrDvYf2lxhfy+w2L4yMFGloSpaWlHVFzkYOFDDj3aqJrdR1Ipdvbba/3rv1ztrAbln1M11klnFdtlNRpr3nxsqMWXIXqzncJJQkkT1MhvGVnyLo+Dz/Aaxrq1mHYuDIMkUn2dAO7UvouR6zMLxQ5CBcp/0vjgzviAsj2CYhUFayTBrqZU0F/+tndpjMXud0bXLJoY83CWVIvgEjmvXdvly0LdtmD/KIAWqtSAv9AJVlvq8Dts/Odms5HE49qBWQXquy9VpKqLrBFWXzQyhxFaG03qt42iWEM5OplXDbdb+tSba30Q6IXOh1VUFth2WKzSDLdV682zjfxwb4i4uiJ81aiKNhNL/NQdYv1eF+mTJZM0rFkncJQrzKDOw423wkkOgL5wmifTJsuvM958xWUa2x7jjGGXiYkzPaPJUnvMLFCy2EAxg4rWAa8jcSRJDF/ZZcknOuPlABgHAKJsNTLecpkRtk6yafcKKqRrbQMk2N7LCV19ENv6kd2vcn+0r15wRmdUz7MM7kiAPybLNvqMl3y/1T6hYY27flyIH8zl931aw7NVZfRGYAqcALBnZWbtwbczK5+R/QWAHV7usYRUri4Zpud/bR6NEYA5NE8TMcSFkSQ+PnFL71IAzlpi6YkjNX9RGb1/+p/EGACS/nQ7Avm+nW96Zj1tVk8ZGAGAnW94ypSA9/nxLv4DY5jBUc50614AAAAASUVORK5CYII=" width="17" height="20" style="display:inline-block;vertical-align:middle">',
  nest_full:  '<img src="data:image/png;base64,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" width="32" height="32" style="display:inline-block;vertical-align:middle">',
  nest_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAE8UlEQVR42l3ST2wcZxnH8ed5/8/szGZb727txMRuYptgE4Mw+VNQqEQvIHFCpEIRQuLAgQOqKkRvgMKVA6rEnRsSshAHEOXAoQeEGpQTkVPRitTQdRw59q53drwz8877Pg+HBJB47t/L8/nh2tpa1xijpJTcNI1M0xS991MAgKIopHOOjDF6MplQp9OJdV2L0WjULC8v29XVVTcej5GI0HsfnHMRNzY2+sYYqZSiqqo0IjZJkmwgxgUAAET03lMtAQxI0IhKMXMQQpQnJycPkiRJhBDsvY9JkgSZZZmRUoL3HqbTaTkYDF4VQlwVAo4QNSPKTCn4FiK+KJV5LAQFKTUj8naWpdnh4ZMPtNYySZLgvQ+KmTGEIIgIiQiZeV1r/cv33rs/BgDY2dk5F7y/GPz84d7fr/0JYDcCANy8efOvIfhvA8C7zjkBAJBlmVBZlllrrXj+B4PIldatvX37tpzNZuqdd/5YfO2rX9r3vu1+45ubfO/eV2ye5+Hjjz9IEFWzuLioicgQEcYYowAAH2MMiOirqmoBAAEAdnd36caNGy0i8MrlSz9aWr7wg7t371Ke52F3d5e0VoQI9LxrAMAbYxpBRCiEYACAfr8PAAAxEgIAb21t4Vtvfe8XeSe9aoz53J07X//55uYmAwDHSMgMGELAwSDFZ11E2e/3e23byhCCRETQ2nxGSvu3117b0QcH+7/pdrt3at+g960UAm+ODj7aOb+18gd/yCKIeDWE8DBG4aSUPJ/PhaiqqsqyzFtrg/c+CAE8mUxiv79ksjS9VUwLf/L0OMzPZk2MocnT7NVLL1zS08ABEamu6+hcDP+Zjej1eiCEYK01ZVkWAAQ8flzy5eXzL/QHnxC2M2iUSucu6U2TzsK82xuojZWl/qgYgZQAw+HQW2tip9MJnU4nCvi/Q2SJOKPa0/U8oXQ12e+MR3t1cbBHq8lHvczMk1N/dh1nM2Jm0bYttq0VIQQEAFBFUVhjjCQirKqKLiwNxHT6STpPf17f6jVQx33x2yfHjwY53v9iN3w/mhzen3/28nS6FZFq+fTpsc3z3CAijMfjoKy1wTlHz7VbRCSALmJ7aquTI37wYYmpwCdNI2DvnwgrwykrmjiAIQLMIcuyNk25PTvj1lpLQmtNUkoGAJBSMhMwQIuNW91rqhIf/Ws+t538FWf1pw+O4hlJh9G+tAcQEFGSUoqr6pmBtZZEWZamLEtTVZUuisIEZrm2dqBffuWN3/1jsnC4eK51q3kZL+b1cr8Tk4Ny+Fhtf+f3G0t7uqWI4/HYVlVlYoz29PTU/BclyzImIkTE5tJSz926det0kl57c2X9In9hU1y49im5fv7lZSo619/47uuvT1668GICINuFBUnO/Q9VWWuDMYabphHOucBMbs5tCQD85k9/9eu3f/aTB/3O/c9zw/yU1+//8Mdvvw8AwE6UUJGbzSQvLnbj0dGMkiSJeOXKlQVjjAwhiLquq16v92Uh6LKU8iFGktOzMD+LGSAipWYuz1lMIiJzhCtC4YfHx5N3jTGpMSYycyuHw2GilEJjDAGADSE8UspEZuoSgHAO09z4rJuERGtIIiMyC2xD2C8K85ckgUQpRXVdkzGGFABAWZYAANi2LfT7fau1vnd4eMh1XUutNbVtKwAAhBAspeTRaNRub2/bLPNpCM965xwBAPwbGfiY2n6VkpsAAAAASUVORK5CYII=" width="20" height="20" style="display:inline-block;vertical-align:middle">',
  nest_geruimd_full:  '<img src="data:image/png;base64,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" width="32" height="32" style="display:inline-block;vertical-align:middle">',
  nest_geruimd_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAEVUlEQVR42j2UQYidZxWG3/d85/v/uZOZzKBpwjUtSFBclIJyVw6DQbGSRaBFCWbRXcFFC3ah4kbaZbe6VagQCkUCNe4GspAgVUpzSxYSLegogyCtzSS507n//b/vO+e4mEnP+vDwnnPe93A2m00B5NaauXtPMkg+PD4+dhHpxnFs0+lUFosFcs4OAOM4ppyz932/ERFsrZmqJgBVSylnU0op52wR0ZVSyubm5ncmk8kGSQWwJDlsbW1lAFlEuvX19eTuj5Zm93py3cwaSTEzS9PpdJMkIsJXq9Vye3v7+znnL2eRZco5qepFVd0leS6lpCRHEaUIn+1TurharT5MKSkAJ1k0IhgRzDk7yUzyq2tr//nx3t4/RgC4cuXK2dbad911/86d2/cSAQvg6tXZ+sOHa79U1d+XUoRkAKCKiJJMtVaICN0x9HFx+vPr00urkP3D8cHR27c+ePf1l7/3hefOXX5ptNb95tZ7b/33aGN9DW1VSlFVlVIKAJiSLJPJxFtrvlqtACC6Uvsa/EEr/sUtyR/+6IWdrz14vHyajP2w2HvlhZ2vHxznw8PWAkAREXZdRxGpCiCP46i1VgcAwPMn/tTHN3/3h1dnM+QL53avJ9hr7dgeNm/vPDPRf7bUNlUty8mYXa015ZzF3SEA4O50d3F3CSBUP0tvvHFZLzy1+ybJG2PDlxx4VlP+7b+WfvXXtz74y6ef1YW7KwCcwlhKCXH3FhGNZCFZKOBHx8fLu3ftxUT+ZFiNFogId2+1WZfSm89/+5vfKqWMJ3JQaq0eEa3ruiYAQDK2trYAAAzyaTyDMrTrZh5CIjwIUEACEdFa++HHk0mBg733fMJwd2qtVUVEF4uFkwTg/HT7yM+WeOAR4Ek7ACAQaM0I90fTOpIpUc6IpppSrfVkh6dRCxGJWmtEMM492pRIeMvMaWYQAUSAZo5qVhC8sb29nSPCx3EMM7PPOQBwamyqqgCIM2cO12/ffv/98LgxWevT4YPH9fFiWTRpcvNf/fHPdz8qpUwAhLtLzlmeBERV1UhKRNjpLry1RgDQtfGn4wrPdX33DYBYjeX24ePxFwA4DEOIiKuqmZmpKiKiSUTQ3Wlm4u70CPZ97wCwt3fvf8PR0Ytd7u6IpHeHkdfu379fAURKKU7tRjOTnPOJwojoRERrrQac3OCT5TJdu3Yt7e/vy3vz+QFmeB5zGICYzWZ66dIlPzg4EFUFyezuUkqRiKC6e+u6jiStlBKM6NP2cHzz5k0DYACAOSpOaz6f1/l8jp2dnaW7r7l7ExExs4iIpl3XNXdnSilKKWMj/z5ZnPnZ7u7lfdKfJAkiAveTdJJ0kl9prf217/uhSlUWBoCWzp8/f4FkTimR5May1r8p4Ga+5m7i7s3d44TrHhHeWhMz+/cwDH8SkQ0bDSQzAGprzUXESZqIeA/kYRjuujtba4nk2Pe9AICIxClMUkredd3G6R9ErTUA+P8BqFXBgGZGd24AAAAASUVORK5CYII=" width="20" height="20" style="display:inline-block;vertical-align:middle">',
  lokpot_full:  '<img src="data:image/png;base64,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" width="20" height="32" style="display:inline-block;vertical-align:middle">',
  lokpot_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAUCAYAAAC9BQwsAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAADJ0lEQVR42mVSS2icZRQ99/7fPzN/0sxkYkYTmqQhLWlItCYGoTuJLiqk0IAimu5ExYUidCP4YNwIbiyiFJfuXCiIiFRxYyIUF1VciGLrIwpp0jzIJJNkXv/33eMiD0a8cOBwz72Xcy8X+H9EADA+VHh04lRhpj3XHtrG5RAAoBG8KKFtNe36fxp5CAAwmnhq8ADssK5dP57CBweSk1CdcRqtS8S9Zsv3CsBI3aaI5A28L2b45uY/tbsAxB0NUAERKSJYnYgmchn3spAhUK8pw22YhjSj4cjusWeRA3p+7J6ptY1KHw2dJDUTyW6hN7/9w63t7wGCbLtWuVzWhYUFAsDyZm3nygsXL09Pjl6YPnd6cnxipPHx9Z8/PdqvXC7r4uIihYAIwHffmH8gjtwjuWw81Wg0no0jgiBq9dRns9mPvPc/1erpt69f/ew3EiKA4L03L79/oiP7UtKRE5qhsl1FsBAOd4mSbAwAaHnvq9X6B69d/fyKvPPq07M9hY4vQzCGEAKNMFpEmIACkgQZjIAqHECsVfZn3akzk3919/RstZrNonNxVK/XxWgADw5BUkhzIRhJMkmSSn57/W83PPbwJd9q9cROQuSiaHV1DSRhB10wEjSDo4n33pJ8oaerODjrwvatebfyCYr9A9LYq6K4voRMrAiBxy/SSomWJ8wIt5WH739y3qF6e9TfWUDqzmlzawXf3djERhXIZQASqDWBkT5gcgRIPZQGaGF6zAnTrKnCJIYIkM9ncHNJsVZpIVJgoJTFVIGAawGisNQQMeQcXaECsLuxs4xGbVcmhjyiKMaNX4BcLHhsylAqtBA8oSDhALquTWVh/HqSH5S9jbUQQgpVopkSZwc0DJXEdvaNTglohJAyJMVhQWHiC/WDT7zVuHduN4nFWcu892K+TlYr0N0KtLkLGNUsDb4zq65RurhjfU+9rTP3J3/Y4PwcRp9f7ioOOAZoKZfKWK+XsyWPTkklpNDO7pPOzjy33Bx65tKF88mSkFQRsa9+Zf+J36+96Dd+fHzn7urpZn2/QECySVLtKvX9qb0PfV0dfuXDuWlZIan/AgwXo+U0rsLNAAAAAElFTkSuQmCC" width="14" height="20" style="display:inline-block;vertical-align:middle">',
  val_full:  '<img src="data:image/png;base64,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" width="24" height="32" style="display:inline-block;vertical-align:middle">',
  val_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAAUCAYAAABSx2cSAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAD+UlEQVR42m1Ub2iVZRw9z/O8733f+2fb3b9m22Q6h27u7pout+WfXiorAyuLLhSILDJSwiIq+tZ1GFRkH4IyGmSQouQisSaTptiltYz5h1UsyyJ1U+eW2+7dvffdfd/neX59qBVE5+PhcA7nwzkM/4NkEhwAurqg57nnnRVREWEvEtHC4lx0O1Ipj+28v+Xh4qD5+BzRQXD7u7ePfDvxr0mSZ88fbTQ4v5c0tRekOh3Nle7tSqUkAYw9d3dsi2WLPZqhkoAsAdcINMEBD5qqhRAhYqiRkt5XxD4LAJM8447uGfx5ls2nPNUeq6KIqo6AG1JprorCm4lo+8Sc2qxHR88tXlKznJFYKaAXSINb15XsYyfjzTtcra5s+vHCMQDY+IhTe0vIeocxtkFrHZSer6SSX1zw8MwPxwamAeDTpqWbI5bZwE7HY17UFMal7Ny63WsW80ZP92qGEtctgIjAOYfgDNrzrg1bYsMb309WLA0FUjO+dI1RX62PCH58Ucj88rbxNJsoCYWCGtI0TUNKCaU1lCelHzCq78x4qWWWYbuapsY8dR8DgO7Gxo41tvm1DxjddVE9Fba5rQiSNKA08iCU5ub0zkmXm1LPnstn12+9eGmYE8APr15U9lF9OYTWqnN0hofTWaR9D0Jr+KZA1JN4ejzHmNJ6b22R3tu+NEcA5wzQNe5c03hx0PhwYTGFNbBtPItKAjKmgXDBx7bxLMKa2AeVQZosskvqbmbaGKA5AOQZ62VZF5fDlrGvpghRT2PLWBo1WRdbx9IoK0jsqy6iq0W2UJm8fzNd+AoARBLgMliezpdam0KEqusCejQc4CtnC2ibcWEAOLAggou2oUsMwRRRX++Joe5kMsk5HId3nz3rM8beNS2TBwh0xRKYMjgiGpjmDL9xDZOIK6lZNue9CgAjIyOMd6VSCgAPFQo9eU8NBwOm0TmW1jWuj96wQFVBYccNV1qM0XQu/97xk2fOJ5NJ3tPTozgASjoO3/f54Oz13FznE1czfpOraH+I0cEIxycVtq73tNE5lpm1p3NJAGgeGWH/dN51+bIeqa0N7vZZd4Ovlx26NcLPlEeoSgTkWMg0/mAsfU/WL1lFfK2pKg6/MpQqEMD5LoAYYLxUVtrTEAo+8ItbeLmvzH62wgxwCJhWwZ84UBW643clX6i3rbVPVosjW+vqbI6/ts4G4y2HMx2rqT+2/LX5lT320LrEow92vLXxrtYl81x/c9OudMftNLQifrQVMDHQEusbb2ul/tjyNwHglOMYiQTEf5+FEgkBACdaml6/0baKBuPNKXwTj/2aaol9DAB/CxgAJBIJ4TiOMX9JANgpxzEAINXSvH8g3vzTn/Cs3dULRJmNAAAAAElFTkSuQmCC" width="15" height="20" style="display:inline-block;vertical-align:middle">',
};

function makeDivIcon(imgHtml, _bg, _border, size){
  // Geen achtergrondvlakje — alleen het icoon met drop-shadow voor zichtbaarheid
  size = size || 'full';
  const shadow = 'filter:drop-shadow(0 1px 3px rgba(0,0,0,.9)) drop-shadow(0 0 2px rgba(0,0,0,.7))';
  if(size === 'full'){
    return L.divIcon({
      className:'custom-div-icon',
      html:'<div style="background:none;border:none;padding:0;display:flex;align-items:center;justify-content:center;gap:3px;'+shadow+'">'+imgHtml+'</div>',
      iconSize:[40,40], iconAnchor:[20,20]
    });
  } else {
    return L.divIcon({
      className:'custom-div-icon',
      html:'<div style="background:none;border:none;padding:0;display:flex;align-items:center;justify-content:center;'+shadow+'">'+imgHtml+'</div>',
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
  val: !!$('f_type_val')?.checked,
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
        <th style="text-align:center;padding:3px 4px" title="Waarnemingen">W</th>
        <th style="text-align:center;padding:3px 4px" title="Lokpotten">L</th>
        <th style="text-align:center;padding:3px 4px" title="Nesten">N</th>
        <th style="text-align:center;padding:3px 4px" title="Geruimd">G</th>
        <th style="text-align:center;padding:3px 4px" title="Vallen">V</th>
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
