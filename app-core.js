// app-core.js — Fix 205
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
import { getFirestore, doc, getDoc, setDoc, collection, getDocs, addDoc, query, orderBy, where, limit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
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
  if(!name) console.log('[app] geen beheerder gevonden voor zone:', z);
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
  map = L.map('map', {
    zoomControl: true, rotate: true, rotateControl: false,
    zoomSnap: 0.25,          // was standaard 1 — nu ook tussenliggende zoomniveaus mogelijk (fijner, en exacter passend voor screenshots)
    zoomDelta: 0.5,          // stapgrootte van de +/- knoppen
    wheelPxPerZoomLevel: 120 // scrollwiel/trackpad reageert geleidelijker i.p.v. in sprongen
  }).setView([52.1, 5.3], 8);
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
  map.pm.setGlobalOptions({
    finishOn: 'dblclick', allowSelfIntersection: false,
    snappable: true,
    snapDistance: 30,     // was standaard 20px — groter vangbereik, makkelijker exact aan laten sluiten
    snapSegment: true,    // snap ook naar lijnstukken van andere polygonen, niet alleen hoekpunten
    snapMiddle: true       // snap ook naar het midden van bestaande lijnstukken
  });

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
// ======================= Wake Lock (scherm niet laten vergrendelen) =======================
// Fix 200: optionele Wake Lock zodat het scherm niet op slot gaat tijdens gebruik van de app.
let _wakeLock = null;
const WAKE_LOCK_PREF_KEY = 'hornetapp_wakelock_enabled';

function isWakeLockPreferred() {
  const v = localStorage.getItem(WAKE_LOCK_PREF_KEY);
  return v === null ? true : v === '1'; // standaard AAN
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (!isWakeLockPreferred()) return;
  if (document.visibilityState !== 'visible') return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch (err) {
    // Kan falen bij bv. lage batterij of geen toestemming — stil negeren
    _wakeLock = null;
  }
}
function releaseWakeLock() {
  if (_wakeLock) { try { _wakeLock.release(); } catch {} _wakeLock = null; }
}
function initWakeLock() {
  if (!('wakeLock' in navigator)) {
    const toggle = document.getElementById('wakelock-toggle');
    const row = document.getElementById('wakelock-row');
    if (row) row.title = 'Niet ondersteund op dit apparaat/deze browser';
    if (toggle) toggle.disabled = true;
    return;
  }
  const toggle = document.getElementById('wakelock-toggle');
  if (toggle) {
    toggle.checked = isWakeLockPreferred();
    toggle.addEventListener('change', () => {
      localStorage.setItem(WAKE_LOCK_PREF_KEY, toggle.checked ? '1' : '0');
      if (toggle.checked) requestWakeLock(); else releaseWakeLock();
    });
  }
  requestWakeLock();
  // Scherm gaat na tab-wissel/vergrendeling automatisch los; opnieuw aanvragen bij terugkeer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
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
  // [debug removed]
  if (_btnAdmin) {
    _btnAdmin.addEventListener('click', async () => {
      // [debug removed]
      try {
        const { openAdminOverlay } = await import('./admin.js');
        await openAdminOverlay(_currentRole);
      } catch(e) {
        console.error('[app] admin overlay fout:', e);
        alert('Beheer kon niet worden geopend: ' + e.message);
      }
    });
  } else {
    // [debug removed]
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
  updateSWStatus();
  updateHeaderHeightVar();
  window.addEventListener('resize', updateHeaderHeightVar, {passive:true});
  document.getElementById('btn-changelog')?.addEventListener('click', openChangelog);
  window.addEventListener('resize', _updateStatusbar, {passive:true});
  window.addEventListener('orientationchange', ()=>{ setTimeout(()=>{ updateHeaderHeightVar(); _updateStatusbar(); }, 250); }, {passive:true});
  setTimeout(()=>{ updateHeaderHeightVar(); try{ map?.invalidateSize(); }catch{} }, 200);

  // ── Android back button: sluit modals/sidebar i.p.v. app verlaten ──
  history.pushState({ app: 'hoornaarzoeken' }, '');
  window.addEventListener('popstate', () => {
    const modals = ['sightline-modal','demo-welcome-modal','delete-account-modal','changelog-modal','zone-edit-modal'];
    let closed = false;
    for (const id of modals) {
      const el = document.getElementById(id);
      if (el) { el.remove(); closed = true; break; }
    }
    if (!closed) {
      const ao = document.getElementById('admin-overlay');
      if (ao?.classList.contains('open')) { ao.classList.remove('open'); closed = true; }
    }
    if (!closed) {
      const pm = document.getElementById('prop-modal');
      if (pm && !pm.classList.contains('hidden')) { pm.classList.add('hidden'); closed = true; }
    }
    if (!closed && window.innerWidth <= 768) {
      window._setSidebar?.(false); closed = true;
    }
    history.pushState({ app: 'hoornaarzoeken' }, '');
  });
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
  nest_full:  '<img src="data:image/png;base64,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" width="28" height="36" style="display:inline-block;vertical-align:middle">',
  nest_small:  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAUCAYAAACEYr13AAAEHElEQVR4nG1TfWiVdRR+zu/33vtuuzndh7rcR21lyECcOtRwOleTUjECuzPa0rJQpKmhyJKE1+u00A38aiFaFBUF12pqMSes2iVRapmlaSmuOS/Zdp1zu7u7u+/X7/THdkWh89/5ep7nwHkI/xMMEBgAAQRwsh56c94sD9xaF+gr299RBwNELetKlhZM0NbHEmhWQuswTb2r4v1QbHSF0Lq5LH8cEjMcRy1NkUI3XTQvPNjxbZKIjq+ZsSw7DXuFkFNSvHLIYh4YTrgjyuUBnVR2mi5dj1fL6Iu7WtxyD6QJeVFIjsIWNyqOnO+jpLxDz0/LykrXcpkdX4ZyOJ41KdeVsnGYce7aIG+vjN0waWL2DNeRBVJTDwumyXFLfUW/T5+eZz/p7S09ct4GAARZ7r/5yg4NWJNwVLZwbc1NJCIu4b23dh7fnSQ865+Xmh6O5tIP5eVaRXu7+8u6Ui1UUDQzTU9tElKUDgzG4DouQIAUAlIwHNP6Hq6qTb147e9NrddNBoSoCIWcYFWVKD1y3rYsay6zUxqNjpger85eXQczYFkOx4YSTto431MJqZVtar1url0720OAIgYEMfi3qgWPlhz7sevzN55p+7dg4tOardhWithVcJVrK0mID8frdjW07DtTOXNKWduFWwwIQYCqb1y14FpJ3q+tL8yrfqnpdOVQf3SzaVvkWKYNSbbPl+LJD/f/sauhZd+J6vmrL5fk/lRfvzIfAAsA8I1Yk3pSvRPCU3M+O12z6LUde07uE467MW2czyM04XkkfOfPmnM9lcdWzK35Jyfj4zsP6XkqMlhESYBBF2ftaLwnkuLhcGHmBy0vzl9Tt7v5UG5XpLMofKdzeVNryalZk5bcnZrz6W1dqkQ0dr2vHxcAgIJBv/T7g6px58ovBLgqZtlWvhR6diS2bfmpq4eRzvTN3KmvRyb69oaFMH2SdMt0927fc7KuvLxcE5cvFzMRMTt8QAhJXoBveuSQbbuLqLt7gC7dvNut01CXchI6oI2MWL29kf5GANTeHnJFIBBQfr9fdvyFn12io4/lZKYUd/efWPHhd8821MwpbK4u27Chqe3weEWr0gWkNRzfeuijM7cNwyCipNEYxAAtbljsC25cVsuFhZPra+YUvlo959LBLUv45MvlWzkzM/3r6oVVAMAGRPIj6Z59DYMQCIAA9WXtssrbGSmne0xbKOJEgUemeHtji1YfbQsZxcXegP+KQwEoBkaZYRhEY6dUZmSIzqLoEzmOOuWYdr49YiJB4pMLj09Zv+XWVasiEHIBwDBAOwJgsGHckzMqbzQ/YFTnvbvtuXfe3rR4nQFDEICg3y/vnzWAB3bBzMQAMYPwP8GAYOYHe1emTcvCGDrfh2gYhggG/XKMlR4AGVPZOXv2+P8AuvrzpeuV45oAAAAASUVORK5CYII=" width="16" height="20" style="display:inline-block;vertical-align:middle">',
  nest_geruimd_full:  '<img src="data:image/png;base64,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" width="28" height="36" style="display:inline-block;vertical-align:middle">',
  nest_geruimd_small: '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAWCAYAAAAmaHdCAAAE5UlEQVR42l1UWWxUZRT+/v+/987cdkr31k6H1ZalQ+m000gFTBEkBqNFgyNr1Ig2Eh/whaAGvdaIRB80oj4UTcAgEdvIWkQMESpohS7IYl2ILQiF0pZC25m7zF2ODzBGOU/n5Mt3Tr6zMdxlpIEfQy1PxfO7C4g1N7upuPWlmiomOW9YDk4u+qRjc1MsJtg3aytnFahije3SnkEDp+q2dup3J66vj8qrVanKJ7xltkeTHQc7juZ27H3sWlQcKOp02d7nKlaNzxRfCIlhxPAsj+F3IuqxiekyZ64gNwtMzM7LUAr7R+0TlkPrT94wuxqau5OpIgwAXo2V5Ef9aoWqYJItMEFhTMhGcshRfdU2YyvH4kZdNrFBlqGWSoKXSUQ5nDGXSax/xHT2sfNlZYHgNVPk3OwZ+a+E9z54ca1sGyu5bURMm9rGksmmt9/Z99kdmG9bVzGutJ8eTjq4yPSqmRcEg9SbxhdMP362t/H1pbNNv2+H3ydKTcuB5biQOQByYep2l6rry1/ecuTCpWmVwWJf8hABQmzIz5+XpipzcxL2g5OXROyh3MDONEkqGtMt27Yd5jgu8zx4lu06Al5oVFGeeKEk1DNneGS7SFfKTcf9jgHASKS8cRyj+ptZCrZHi5AIqN44SeHEOZKWBcuywAEYgJftEX+6vQ95I0mMkLcl63T3OkYAZ4DXs+i+9slXRyuH8lTsqr1XJBQFiuPCZYAgQsJ1IcV1PNveZ98zZotLGUrLpBNnllAsJsSbAHI2Lq88V5a3wW9acknvTV48OMbOZstIcAYfEWxFhmJZWHXqCoIDOmufkcu/rA7Ja8qn76zYvlvnDCBb2KrfRdqhSBCd4QJWfMPAM2euI0sIGGk+CMPEivY+FA/oaCvJ5Aem5sNne1N6FD2bAcQAgIjYuxuX9kiymGQIeItP9/Ho+QFcG5+JPdEg6jqvInRlFJ3Tc7FvZqGrEvGxUb1r88dHqjUNnGtarcQYI+LisCQ4WDzp7Z+ej66ZhSga0lH//V8IDSXwSzgfB8KFUFyQJAmmqmrz7ZWp5RIw3wNaQZy/b3tUL3PGPUmio9PyWWn/GDLGLMTTZBwaH4BuWl5BepqIJ8zLGEp8SATGWKvLGxoaPE3T+GsNX/3p2d5uNSfAZdP0nmy7iIy4hcGAjEDcwerOfuRyQZbnMH04/nbD561mc3OMAyABAK3HWkHdMXEik30L5i5cffp6UejvW3QqV+FbpmahSJExrfeWXWp5vCMgPtq09eimjvqovOiVI86/B5jalV5M9AerMloU0MJfgwH6tFiFokhM8sneij+GefnlOOC6R9pcvmxOd/dwisdTzuHCWemF0ayDiiQtHFCltv3VITsULGA56enJTEXiu2bkn9TJ24UM/0OVCms5PqE8mwFeEyA4A7yfQjXqA0HaoypiQdyy9xf++Pg8ePx5z0qaVtJU9LjVYblyXfqZ31YkjGSTP025vzoPLR1ToplPAS62Taz1G5XlB2lulPRIeLeGWonotsyN6x6Z8db6xY/GYjEFACgWEzFA6JGyr2luFZlVM1s7otFMGJHyk1RTSUZFuLkRUZkARgDXNI3/7/cS2B2MaaiVjIpwM9VEyIiEz8GIhH9OVISPNSIqsztNThE1TeOaViulBpAaAgGsEVHZiIRbExXhH/4BTRw+aPkvjewAAAAASUVORK5CYII=" width="17" height="22" style="display:inline-block;vertical-align:middle">',
  lokpot_full:  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAkCAYAAACTz/ouAAAC8UlEQVR4nO1VQWhTWRQ9992fHxMTnGpbDDgIoRS3EqQqSAXBvUIDbgQHZyUquJiNi8Gl4MKdSxezssWlIBUXARddWBQ0UURQIZhqB6uN+pv8/++ZRVJt60+MjAOz6IEHn//evefec999F9jE/xHynzsbGxtLDw8Pu3q9PpATVWWhUJC5ubmgH4EDYOPj43tSqdQ9kpleASQgcs55Zna9Vqudm5yclEqlEq06BQCUSiXtRnNSVXeQ3AIgM8gSkTzJDMnfi8VirutcAMBLCockSEYA/AEzIAAREdu48YUgl8sRADzPewwgVFUVGbjedM4JyUftdruNjjJcR1CpVAgAjUajns/nYwBKkhigDiSpqgjDsF6v1+OpqSmZmZkxbDBOAQhHR0cvi8gfcRyH3X8DZYCORHEURTuWlpY+dH0zqQbmnKMTECABYTfbJMjqPiGIY1vZeMCt+bZuupWwHcqHz/SbAaQZ0DUD9FrSDOiWA3GfgkhSnvdyYmJiZa0yazOIp6entVwu3z51/tSfB/TOmaFf+ACaJsDEOpAQqEa29LbwnHv9W48L1/K5OMKalNdJVK1WBYA7/tvx2u65u61c9GbE1Nde+nREUnO5j5mRkZ1v7i7sXK7+dVUBxIkEq1I1XjSyQwFcK0CGzvoSmAj9GN5yJvKs1fIyGwqW2Gjqq6kAqjBK/2sqAipB50CIfHMbXJLRz8QmwSbBv0diH3yBOMD1b2TAdc71eBATCcR5RguNK4FRgv7zQEAYjHSJDOsJDh8GLl0CCvuy6W0Xt6af3fhs6awH+2YSfvVuIf3sdj9dPJvFzSsolUqYn59PJqgtLhIA7N2Lhwu7jiz4vx4LaTF6l8pgBH1f06+rD1+13i2GhWJR0ItgplyOSYqI3D9x5vSFsPlxPxSBmfS5DAbPT8n7138HGd/XxtDQOql6vPMUEeGhgwePSgyvM7V6g9a2Lfl8Vjzvyezs7NNV+342IJOHzI/ie05+tE+IPgN8E4n4BxkvTv5yDvq9AAAAAElFTkSuQmCC" width="24" height="36" style="display:inline-block;vertical-align:middle">',
  lokpot_small:  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAeElEQVR4nGNgoBAwwhhaWlr/SdV87do1RiZKXTDwBrDAGG/evBkYF1DPC69evWJkYGBgmLZvyxbzcxHKuDScNFpxd0PHpA0MDAwMu3btGgReGHgDWLAJssbf4MKp4/IFwgYcuXzhMrEuYMQl4ebmlkJI865du+YAAIxcHy/OUEvCAAAAAElFTkSuQmCC" width="16" height="16" style="display:inline-block;vertical-align:middle">',
  val_full:  '<img src="data:image/png;base64,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" width="30" height="36" style="display:inline-block;vertical-align:middle">',
  val_small:  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAASCAYAAABSO15qAAADBElEQVR4nHWSzW9bRRTFz70z78Px13Nrp2oLChACQRHtohJI3WSFN2WHxKJLFvGfkKX/AzbsEBI7FGwBQiwjRUhsACkFCREaIaWQBpM2ij/jZ7/3ZuaycNrEqrjS3VzN+c2Zc4cAoAWoNqA+Wqx8teip98sLgVUE5QTQTNKfZjJM0vRp5u59cDrYaQHqQ8ACgBaACLDbFRQWzLR+kgj6k5gjT2NoLCJP09/jqVn2VUgi7wHYeQ1gPAPgvIor78jZpB8nxvgnxqHPjKkTdJlwVrAY50NkwBjdfeDOHWB3FzOAzDx8svIu1ut3uRJFkHiMmBkAEANQAD2JrmD/4e+59a9bevf+faDRADCzAgA4Pf0TRa3lxpWK3KzV8FK1etG1RVzNhW54cny33++/2Wg0smazyXOAIAjYQaRytfq5E5k4AYxz1gtCdPvdHx78+uBja8VorZ9rAICJSFqtlvJ9fzQYDD6bxLEoZhKIg4hTTM4ZNx51ew+LxZJeW7tdBYC9vT167qDX63G73bbpNIlH6fQVv5D/LV8qsQ4DzynmsJhflyifU0pNiORtANRut93cFmbv8HJ+p7f2VuX6lyec9WzKgjjlSBWw5C+9uh0f6Mza0vlpeQFgNCfeYFqLMvM0Kgb/AjnAOULoZVCTte+FcmBklzXzDuBAIpLuH9TjkBdYRGZzYlg3TLXEYq36XwAB7EJP2WxaAnHg4M7nxCywBc/PyFMyt4U5QGIGk5tlpHmfGciI2BCxEaLUh8q9jsJSoVZTs7suATY2NgwAfLv786edx0cD0RSKE4iARECAwAEqBO3nvOANACIi9IKD417PMrEJhG0gZAPM2heWILNx6Vr1dhCGL99aXV0hImk2mzyXwa0g4MTZ6s4NW+12B6lWmmYxCphgr19bDP0D8Q1f6BgAiEgAYHNzMz76p3Pvp0d//HiqbXqUjiYdM5p2zFlymAwn32x/98XhX49+WV5efvYXLsK4XPV6fbVaLofGmIvEU+Dx8WFSrtVyURQ92dra6gCg/wC7P2g7MFcP6gAAAABJRU5ErkJggg==" width="16" height="18" style="display:inline-block;vertical-align:middle">',
};

function makeDivIcon(imgHtml, _bg, _border, size){
  // Voeg attrs toe aan img tags om browser "afbeelding opslaan" te blokkeren
  const safeHtml = imgHtml.replace(/<img /g,
    '<img draggable="false" oncontextmenu="return false" ');
  // Transparante overlay div over de img — vangt long-press events op
  // zodat de browser de onderliggende img niet als download-target ziet
  const overlay = '<div style="position:absolute;inset:0;z-index:1;-webkit-touch-callout:none;user-select:none;touch-action:none" oncontextmenu="return false"></div>';
  size = size || 'full';
  if(size === 'full'){
    return L.divIcon({
      className:'custom-div-icon',
      html:`<div style="position:relative;background:none;border:none;padding:0;display:flex;align-items:center;justify-content:center;gap:3px;-webkit-touch-callout:none;user-select:none;touch-action:none">${safeHtml}${overlay}</div>`,
      iconSize:[40,40], iconAnchor:[20,20]
    });
  } else {
    return L.divIcon({
      className:'custom-div-icon',
      html:`<div style="position:relative;background:none;border:none;padding:0;display:flex;align-items:center;justify-content:center;-webkit-touch-callout:none;user-select:none;touch-action:none">${safeHtml}${overlay}</div>`,
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

// ── Inline icoon HTML voor gebruik buiten kaart (filter, acties, overzicht) ──
function iconHtml(type, size=16) {
  const img = IMG[type+'_small'] || IMG[type+'_full'];
  if (img) return img.replace(/width="\d+"/, `width="${size}"`).replace(/height="\d+"/, `height="${size}"`);
  // Fallback emoji
  const em = { hoornaar:'🐝', nest:'🪹', nest_geruimd:'✅', lokpot:'🪤', val:'🪝', polygon:'⬡' };
  return em[type] || '📍';
}

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
  <button data-act="fix_sector">🔧 Sector herstellen</button>
  <button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    if(act==='delete'){ deleteSightLine(line,true); }
    else if(act==='color'){ openColorModal(line._meta?.color||'#ffcc00', col=>{ setSightLineColor(line,col,true); }); }
    else if(act==='note'){ openLineNoteModal(line); }
    else if(act==='fix_sector'){
      // Verwijder en hermaak de sector voor deze lijn
      if(line._sector){ const sid=line._sector._meta?.id; if(sid) deleteSectorFromCloud(sid); circlesGroup.removeLayer(line._sector); line._sector=null; }
      const m=line._meta||{}; const ll=line.getLatLngs();
      if(ll.length>=2 && m.pot){
        const dist=Math.max(1,m.distance||50); const brg=((m.bearing||0)+360)%360;
        const rInner=Math.max(1,dist-25), rOuter=dist+25;
        const sector=createSectorLayer({id:genId('sect'),pot:m.pot,distance:dist,color:m.color||'#ffcc00',bearing:brg,rInner,rOuter,angleLeft:45,angleRight:45,steps:36,flightId:m.id}).addTo(circlesGroup);
        registerSector(sector); line._sector=sector; sector._line=line;
        persistSector(sector);
      }
    }
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
  // Hint tonen bij read-only eigen markers (niet bij GBIF/import)
  const isImportMarker = init.source === 'GBIF' || init.source === 'waarneming.nl';
  let hintEl = document.getElementById('pm-edit-hint');
  if (!hintEl) {
    hintEl = document.createElement('div');
    hintEl.id = 'pm-edit-hint';
    hintEl.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:8px;text-align:center';
    pmCancel2?.parentElement?.appendChild(hintEl);
  }
  hintEl.textContent = (ro && !isImportMarker && canWrite()) ? '✏️ Lang indrukken op het icoon om te wijzigen' : '';
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
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_hoornaar" checked/> <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAWCAYAAADNX8xBAAAE7UlEQVR42m2Ua2wUVRTH/3Nnd2en+6bdbp+0S0voCygPm1I1xVJoFVKwumtiYquf1BCMETRAJMNCDMQoYCsmmvDSGEw3IUQUBERaqLSxYKu25WEp9EW7fWxf2+3OzM5cP7RbS+B+ujfnnN/NOed/DoPZQwHmkGtJjgyaKak0bCDRF7Z7G6cFgHgAFQADgO7ZklGoZRDPEqVvYIr+Uf1Lh4hZ4xPno+KUzBBV81iWnjt8qdcvCCDZ7S7mytCfmzg9Hek3dTZ4vVCeFosaF9i/D0StisBduXF296rYLa4sGAHAnZeY78pPSo/4N+8zZJ+oTNFH3gQABAHE7YVqsoqmB6c0+QDgbRkYsZlMZUHToh+LVqTUaDj+0/DUSAgA7n3NpRmt8uI3U7skQZhhEADweKBSAYzzXaWW0THptFW/EAAvEs6ZsHiFzexIyaRR1h7/hE5DKQzcAmV9c5x0DntBPR6oj9WI0pn7SAMSxE5S0dqsVglnDGtEnYUnLDs6PdTT0T5km+4+Of4GZ1ZbHOWopxSEYWZAJAJiGFCvGySmAH3Hj+ke/lBnXK3TcCZneuap+IWLKwxak7x+Oe/86oQRjnLUC8L/kMdAANCWBQoAe66GTqssH7MoVpsYUNgBCZq6jHijQSOLWQfrJr58WrM0c6nVgGXcUK7vZIt/bdMFEhS5ODgtNTT5hj7WE3KzlPdrgjxblrUh5m5x1kTcix7p55oasG73jAwIpWAikK7v2WKbnVl+t0snhhW5pL4vPJSVnn6hwG73nekWR3kNcgI+JS3OEbb3nyRutxsKFUCoMC+z3hPa3NaDuj0AcLjEdvTbcpMXcBgybIacmaaYFxwtNe2rLjVfAYDbBzTbu4+zJXM1bvnEkMPxqhNaVcrcJl7cUWBOWxZNO1gS3uoLKX3tStxnk5Py2FpN/25Jz0fFWHRnewJ0w85LE5fvVHFFHFSHJGo6yfAoyOi49vfMbeJFALBCOsLpVNrrCzdmZ5CtrhI5/dVnghnrljBl8mi4V5LFIb0sVQHQZLwn/tbXI/8UCJBpzNfRrjzDC99t4umxcnODAzBAm1tRVFiiWJ3Lds266b/ZZKw5+5qZvr+Ce2f+pDIRidd6CsnGtU0NSxdqV94fZ488y/kDgWy+8sGYNYl2jl4rMIS6mx5AP24z3E+O0e2+3TPt6x61Lq1qGRj2ukAIakE8HqjPPX/zFauVX82aokhOcmjCN4m7j6aYSXBTSk6q/EgfhXvDErmxMkn0hQgZt0abHHEOZSsD0LZBMKQ9dkaENktUhSnaBplVL6bEBidMhOjTZNlh8SuK7KOOoB9rzAyNdyaqJMaK6pDWrOgM/FuVKdB76hAmXi+UykLojXb7S8My15ie5N+parl/Wgc0Nzg5HEy2BIctetUwGELsoERu+jRRTWucI2dE8J54u3lhwpL41LkR4QJQVK1x77VH8aW2BWqiqLBtb9+S7vj70WzpR/JgN3K7xmD9K6hcztkcaOqTtMt2nG7dPxbWbouOThh+Yl7oeZjvVetfjyy6z/OR2LiRGawtAj20Chsifv8eYjc/rIJzfiwBACqAnP8inevs0JeJY7geMW5vRN/tcfblLolUfHALl2pcYCkFExhX6jCtXVf/YbRpbjzo7E66KlhSW/ZzRRHwfBsACPM+BYBmgc9r3GXMimzY/wAF5RKYIodq4QAAAABJRU5ErkJggg==" width="16" height="18" style="display:inline-block;vertical-align:middle"> Waarneming</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_nest" checked/> <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAUCAYAAACEYr13AAAEHElEQVR4nG1TfWiVdRR+zu/33vtuuzndh7rcR21lyECcOtRwOleTUjECuzPa0rJQpKmhyJKE1+u00A38aiFaFBUF12pqMSes2iVRapmlaSmuOS/Zdp1zu7u7u+/X7/THdkWh89/5ep7nwHkI/xMMEBgAAQRwsh56c94sD9xaF+gr299RBwNELetKlhZM0NbHEmhWQuswTb2r4v1QbHSF0Lq5LH8cEjMcRy1NkUI3XTQvPNjxbZKIjq+ZsSw7DXuFkFNSvHLIYh4YTrgjyuUBnVR2mi5dj1fL6Iu7WtxyD6QJeVFIjsIWNyqOnO+jpLxDz0/LykrXcpkdX4ZyOJ41KdeVsnGYce7aIG+vjN0waWL2DNeRBVJTDwumyXFLfUW/T5+eZz/p7S09ct4GAARZ7r/5yg4NWJNwVLZwbc1NJCIu4b23dh7fnSQ865+Xmh6O5tIP5eVaRXu7+8u6Ui1UUDQzTU9tElKUDgzG4DouQIAUAlIwHNP6Hq6qTb147e9NrddNBoSoCIWcYFWVKD1y3rYsay6zUxqNjpger85eXQczYFkOx4YSTto431MJqZVtar1url0720OAIgYEMfi3qgWPlhz7sevzN55p+7dg4tOardhWithVcJVrK0mID8frdjW07DtTOXNKWduFWwwIQYCqb1y14FpJ3q+tL8yrfqnpdOVQf3SzaVvkWKYNSbbPl+LJD/f/sauhZd+J6vmrL5fk/lRfvzIfAAsA8I1Yk3pSvRPCU3M+O12z6LUde07uE467MW2czyM04XkkfOfPmnM9lcdWzK35Jyfj4zsP6XkqMlhESYBBF2ftaLwnkuLhcGHmBy0vzl9Tt7v5UG5XpLMofKdzeVNryalZk5bcnZrz6W1dqkQ0dr2vHxcAgIJBv/T7g6px58ovBLgqZtlWvhR6diS2bfmpq4eRzvTN3KmvRyb69oaFMH2SdMt0927fc7KuvLxcE5cvFzMRMTt8QAhJXoBveuSQbbuLqLt7gC7dvNut01CXchI6oI2MWL29kf5GANTeHnJFIBBQfr9fdvyFn12io4/lZKYUd/efWPHhd8821MwpbK4u27Chqe3weEWr0gWkNRzfeuijM7cNwyCipNEYxAAtbljsC25cVsuFhZPra+YUvlo959LBLUv45MvlWzkzM/3r6oVVAMAGRPIj6Z59DYMQCIAA9WXtssrbGSmne0xbKOJEgUemeHtji1YfbQsZxcXegP+KQwEoBkaZYRhEY6dUZmSIzqLoEzmOOuWYdr49YiJB4pMLj09Zv+XWVasiEHIBwDBAOwJgsGHckzMqbzQ/YFTnvbvtuXfe3rR4nQFDEICg3y/vnzWAB3bBzMQAMYPwP8GAYOYHe1emTcvCGDrfh2gYhggG/XKMlR4AGVPZOXv2+P8AuvrzpeuV45oAAAAASUVORK5CYII=" width="16" height="20" style="display:inline-block;vertical-align:middle"> Nest</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_nest_geruimd" checked/> <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAWCAYAAAAmaHdCAAAE5UlEQVR42l1UWWxUZRT+/v+/987cdkr31k6H1ZalQ+m000gFTBEkBqNFgyNr1Ig2Eh/whaAGvdaIRB80oj4UTcAgEdvIWkQMESpohS7IYl2ILQiF0pZC25m7zF2ODzBGOU/n5Mt3Tr6zMdxlpIEfQy1PxfO7C4g1N7upuPWlmiomOW9YDk4u+qRjc1MsJtg3aytnFahije3SnkEDp+q2dup3J66vj8qrVanKJ7xltkeTHQc7juZ27H3sWlQcKOp02d7nKlaNzxRfCIlhxPAsj+F3IuqxiekyZ64gNwtMzM7LUAr7R+0TlkPrT94wuxqau5OpIgwAXo2V5Ef9aoWqYJItMEFhTMhGcshRfdU2YyvH4kZdNrFBlqGWSoKXSUQ5nDGXSax/xHT2sfNlZYHgNVPk3OwZ+a+E9z54ca1sGyu5bURMm9rGksmmt9/Z99kdmG9bVzGutJ8eTjq4yPSqmRcEg9SbxhdMP362t/H1pbNNv2+H3ydKTcuB5biQOQByYep2l6rry1/ecuTCpWmVwWJf8hABQmzIz5+XpipzcxL2g5OXROyh3MDONEkqGtMt27Yd5jgu8zx4lu06Al5oVFGeeKEk1DNneGS7SFfKTcf9jgHASKS8cRyj+ptZCrZHi5AIqN44SeHEOZKWBcuywAEYgJftEX+6vQ95I0mMkLcl63T3OkYAZ4DXs+i+9slXRyuH8lTsqr1XJBQFiuPCZYAgQsJ1IcV1PNveZ98zZotLGUrLpBNnllAsJsSbAHI2Lq88V5a3wW9acknvTV48OMbOZstIcAYfEWxFhmJZWHXqCoIDOmufkcu/rA7Ja8qn76zYvlvnDCBb2KrfRdqhSBCd4QJWfMPAM2euI0sIGGk+CMPEivY+FA/oaCvJ5Aem5sNne1N6FD2bAcQAgIjYuxuX9kiymGQIeItP9/Ho+QFcG5+JPdEg6jqvInRlFJ3Tc7FvZqGrEvGxUb1r88dHqjUNnGtarcQYI+LisCQ4WDzp7Z+ej66ZhSga0lH//V8IDSXwSzgfB8KFUFyQJAmmqmrz7ZWp5RIw3wNaQZy/b3tUL3PGPUmio9PyWWn/GDLGLMTTZBwaH4BuWl5BepqIJ8zLGEp8SATGWKvLGxoaPE3T+GsNX/3p2d5uNSfAZdP0nmy7iIy4hcGAjEDcwerOfuRyQZbnMH04/nbD561mc3OMAyABAK3HWkHdMXEik30L5i5cffp6UejvW3QqV+FbpmahSJExrfeWXWp5vCMgPtq09eimjvqovOiVI86/B5jalV5M9AerMloU0MJfgwH6tFiFokhM8sneij+GefnlOOC6R9pcvmxOd/dwisdTzuHCWemF0ayDiiQtHFCltv3VITsULGA56enJTEXiu2bkn9TJ24UM/0OVCms5PqE8mwFeEyA4A7yfQjXqA0HaoypiQdyy9xf++Pg8ePx5z0qaVtJU9LjVYblyXfqZ31YkjGSTP025vzoPLR1ToplPAS62Taz1G5XlB2lulPRIeLeGWonotsyN6x6Z8db6xY/GYjEFACgWEzFA6JGyr2luFZlVM1s7otFMGJHyk1RTSUZFuLkRUZkARgDXNI3/7/cS2B2MaaiVjIpwM9VEyIiEz8GIhH9OVISPNSIqsztNThE1TeOaViulBpAaAgGsEVHZiIRbExXhH/4BTRw+aPkvjewAAAAASUVORK5CYII=" width="16" height="16" style="display:inline-block;vertical-align:middle"> Nest geruimd</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_lokpot" checked/> <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAl0lEQVR4nGNgGGyAEcbQ0tL6T64h165dY2SijnsYGAafQSwwxps3bygyaBB77dWrV4wMDAwM0/Zt2WJ+LkKZkMaTRivubuiYtIGBgYFh165dg9Brg88gFmyCrPE3uAjqvHwBhcuITc20fVu2EDIHFmMMDAwMu3btmoPVIAYGBgY3N7cUgq5CMghnGO3atWsOsYYwMDAwAABdNimIF3+3ngAAAABJRU5ErkJggg==" width="14" height="18" style="display:inline-block;vertical-align:middle"> Lokpot</label>
          <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="fm_val" checked/> <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAASCAYAAABSO15qAAAC3ElEQVR4nHWST29TRxTFz52Z98ch2A55L5JtssFEDVmwQYBaFrDBG7o1Cz5A/BGytPgcLFi1imJRtYuuiiKxK0WIFUGBqlESxxA3JnbyYvu9NzOXRZwE8+dKVxpp5h7d8ztDALBShVx4DemnpSdZST9Hhg0ASQAswJLALijpg+9dfruzulKFvN+AAQDFAFED5i9g8mIhquww0Em0CD0H/8cpQs+l1iDWN7O+vztM7wJYvfQfBDASwKjSGze42d/vR9q4B4Zx5Ah0E4MjV2FvIsX6pI/I4gjtdQDXALzEsQAzQIRf5m7iduUnMZXPgfp99EhAEtBjwBeEdjaP9fW1zO3fVtTLBw+AWg0AIE426HTe4bxSXJqeRikMMRsGKAYBZsMApSAQwbkJHLR3b3W73R9qtVpar9fFmAWtNRlmNzUGlhmW+eQKRAQYA22MxRcliIjr9bqampqKoqj3WEkJAdLE4JOGZSIwl8tz1wuFwnkAWFtbo1MLxWKRGo2GieOkCUdCu1JxxqGTtr4j2HPI9/1zvu8vVKtV2Wg07JgFALCuysidfb7USTa1hIeRDbbMKuPJbWuzTHSh3W4TAP5KwAiQ3Iv48rvB+74vMmSPH8FYRjZ1/ykgC0B/PjMmQEQMQRh60ok9cs4EwOQJBUnEAI1BHEPKLNl3CASQPYNIBJaarRyalGH5uwIiNd1BKYc4o1zBfBoZkyBvaJJgb9hTucmJO8+e2TGBxcVFDQC/v3j+qLXd7LESHttjhAyACaST1EwXZqavzC38+BBgZqavNviwv28ECe2xMB6T8TDq0dkRKrHGZK/Oz8+N/o8Yg3jV80RsTbBaNMHHj71ESUXHSTIkwcyEM776l5UWZ3PilD6ApaWlfnOnde/5xpu/O8okzeRw0NKHw5aO4s34YPDH0z9/3drceFUul7OnyeEbValU5oNcztdanxFPgO0PW3EuDDP5fH53eXm5BYA+AVS7YWviAbXLAAAAAElFTkSuQmCC" width="16" height="18" style="display:inline-block;vertical-align:middle"> Val</label>
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
let _actionLogPeriod = 'week'; // standaard week
let _actionLogScope  = 'auto'; // 'own' | 'all' | 'auto'
let _actionLogShowAll = false;
const ACTION_PAGE_SIZE = 10;

// ── Schrijf actie naar Firestore ──────────────────────────────────────────
async function _persistAction(type, meta, markerId, latlng, memEntry) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const zone = normalizeZone($('sel-group')?.value || DEFAULT_GROUP);
  const year = $('sel-year')?.value || DEFAULT_YEAR;

  // Adres ophalen via reverse geocode
  let address = '';
  if (latlng?.lat != null && latlng?.lng != null) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latlng.lat}&lon=${latlng.lng}&format=json&addressdetails=1`, {headers:{'Accept-Language':'nl'}});
      const d = await r.json();
      const a = d.address || {};
      const road = a.road || a.pedestrian || a.path || '';
      const nr   = a.house_number || '';
      const city = a.city || a.town || a.village || a.hamlet || '';
      address = [road + (nr ? ' ' + nr : ''), city].filter(Boolean).join(', ');
    } catch { /* geocode optioneel */ }
  }

  // In-memory entry bijwerken met adres
  if (memEntry && address) {
    memEntry.address = address;
    _renderActionLog();
  }

  try {
    await addDoc(collection(_db, 'activity', uid, 'log'), {
      type,
      markerId: markerId || null,
      note:     meta?.note   || '',
      by:       meta?.by     || _currentDisplayName || '',
      zone,
      year,
      date:     new Date().toISOString().slice(0,10),
      ts:       serverTimestamp(),
      displayName: _currentDisplayName || '',
      address,
      lat: latlng?.lat || null,
      lng: latlng?.lng || null,
    });
    console.log('[activity] opgeslagen:', type);
  } catch(e) { console.warn('[activity] opslaan mislukt:', e.code, e.message); }
}

function _logAction(type, meta, marker){
  const labels = { hoornaar:'Waarneming', nest:'Nest', nest_geruimd:'Nest geruimd', lokpot:'Lokpot', val:'Val', polygon:'Polygoon' };
  const icons  = { hoornaar: iconHtml('hoornaar'), nest: iconHtml('nest'), nest_geruimd: iconHtml('nest_geruimd'), lokpot: iconHtml('lokpot'), val: iconHtml('val'), polygon:'⬡' };
  const label  = labels[type] || type;
  const icon   = icons[type]  || '\u{1F4CD}';
  const time   = new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'});
  const zone   = normalizeZone($('sel-group')?.value || DEFAULT_GROUP);
  const markerId = marker?._meta?.id || null;
  const latlng = marker?.getLatLng?.() || null;
  const entry = { icon, label, time, note: meta?.note||'', by: meta?.by||_currentDisplayName||'', marker, type, zone, markerId, ts: Date.now(), address: '' };
  _actionLog.unshift(entry);
  if(_actionLog.length > 100) _actionLog.pop();
  _renderActionLog();
  _persistAction(type, meta, markerId, latlng, entry);
}

// ── Laad acties uit Firestore ─────────────────────────────────────────────
async function _loadActivityLog() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const el = document.getElementById('action-log-list');
  if (el) el.innerHTML = '<div style="color:#94a3b8;font-size:12px;padding:6px 0">Laden…</div>';

  const effectiveScope = (_actionLogScope === 'auto')
    ? (canEdit() ? 'all' : 'own')
    : _actionLogScope;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (_actionLogPeriod === 'week' ? 7 : 1));
  const cutoffStr = cutoff.toISOString().slice(0,10);

  try {
    let entries = [];

    if (effectiveScope === 'own' || !canEdit()) {
      let snap;
      try {
        snap = await getDocs(query(collection(_db, 'activity', uid, 'log'),
          where('date','>=', cutoffStr), orderBy('date','desc'), orderBy('ts','desc'), limit(200)));
      } catch(qErr) {
        // Index nog niet aangemaakt — probeer simpelere query
        if (qErr.code === 'failed-precondition' || qErr.message?.includes('index')) {
          snap = await getDocs(collection(_db, 'activity', uid, 'log'));
        } else { throw qErr; } // permissions of andere fout — gooi door
      }
      snap.forEach(d => { const data=d.data(); if(data.date>=cutoffStr) entries.push({...data,uid}); });
    } else {
      const allUids = await _getAllUidsInZones();
      for (const u of allUids) {
        let snap;
        try {
          snap = await getDocs(query(collection(_db, 'activity', u, 'log'),
            where('date','>=', cutoffStr), orderBy('date','desc'), orderBy('ts','desc'), limit(100)));
        } catch(qErr) {
          if (qErr.code === 'failed-precondition' || qErr.message?.includes('index')) {
            try { snap = await getDocs(collection(_db, 'activity', u, 'log')); } catch { continue; }
          } else { continue; }
        }
        snap.forEach(d => { const data=d.data(); if(data.date>=cutoffStr) entries.push({...data,uid:u}); });
      }
    }

    entries.sort((a,b) => (b.ts?.seconds||0) - (a.ts?.seconds||0));

    const icons  = { hoornaar: iconHtml('hoornaar'), nest: iconHtml('nest'), nest_geruimd: iconHtml('nest_geruimd'), lokpot: iconHtml('lokpot'), val: iconHtml('val'), polygon:'⬡' };
    const labels = { hoornaar:'Waarneming', nest:'Nest', nest_geruimd:'Nest geruimd', lokpot:'Lokpot', val:'Val', polygon:'Polygoon' };
    _actionLog.length = 0;
    entries.forEach(e => {
      const ts = e.ts?.seconds ? new Date(e.ts.seconds*1000) : new Date();
      const liveMarker = e.markerId ? allMarkers.find(m => m._meta?.id === e.markerId) : null;
      _actionLog.push({
        icon: icons[e.type]||'📍', label: labels[e.type]||e.type,
        time: ts.toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'}),
        date: e.date, note: e.note||'', by: e.by||e.displayName||'',
        zone: e.zone||'', type: e.type, markerId: e.markerId,
        isOwn: e.uid===uid, marker: liveMarker||null, address: e.address||'',
      });
    });
    _actionLogShowAll = false;
    _renderActionLog();
  } catch(e) {
    console.warn('[activity] laden mislukt:', e.code || e.message);
    if (e.code === 'permission-denied') {
      const el2 = document.getElementById('action-log-list');
      if (el2) el2.innerHTML = '<div style="color:#f59e0b;font-size:11px;padding:6px 0">⚠️ Firestore rules niet bijgewerkt — upload firestore.rules</div>';
    } else {
      _renderActionLog();
    }
  }
}

async function _getAllUidsInZones() {
  // Haal alle users op waarvan zones overlappen met _currentZones (of alle voor admin)
  const snap = await getDocs(collection(_db, 'roles'));
  const uids = [];
  snap.forEach(d => {
    const data = d.data();
    if (!data.role || data.role === 'pending') return;
    if (_currentRole === 'admin') { uids.push(d.id); return; }
    // Manager: alleen users in eigen zones
    const userZones = (data.zones||[]).map(normalizeZone);
    if (userZones.some(z => _currentZones.includes(z))) uids.push(d.id);
  });
  return uids;
}

function _renderActionLog(){
  const el = document.getElementById('action-log-list');
  if(!el) return;

  const canSeeAll = canEdit();
  const effectiveScope = (_actionLogScope==='auto') ? (canEdit()?'all':'own') : _actionLogScope;

  // Header
  const mkBtn = (dp, ds, label, activeVal, activeCurrent) => {
    const isAct = activeCurrent === activeVal;
    const base = dp ? (isAct ? '#0aa879' : '#fff') : (isAct ? '#0f172a' : '#fff');
    const col  = dp ? (isAct ? '#fff' : '#64748b') : (isAct ? '#fff' : '#94a3b8');
    const bord = dp ? '#cbd5e1' : '#e2e8f0';
    return `<button ${dp?`data-p="${dp}"`:`data-s="${ds}"`} class="al-btn${isAct?' al-active':''}"
      style="padding:3px 10px;font-size:11px;border-radius:12px;border:1px solid ${bord};cursor:pointer;background:${base};color:${col}">${label}</button>`;
  };
  const headerHtml = `<div style="display:flex;gap:5px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
    ${mkBtn('day',null,'Vandaag',_actionLogPeriod,'day')}
    ${mkBtn('week',null,'Week',_actionLogPeriod,'week')}
    ${canSeeAll ? mkBtn(null,'own','Mijn',effectiveScope,'own') + mkBtn(null,'all','Iedereen',effectiveScope,'all') : ''}
  </div>`;

  if(!_actionLog.length){
    el.innerHTML = headerHtml + '<div style="color:#94a3b8;font-size:12px;padding:6px 0">Geen acties in deze periode.</div>';
  } else {
    const visible = _actionLogShowAll ? _actionLog : _actionLog.slice(0, ACTION_PAGE_SIZE);
    const hasMore = !_actionLogShowAll && _actionLog.length > ACTION_PAGE_SIZE;
    let rows = '';
    let lastDate = '';
    visible.forEach((a, idx) => {
      if (a.date && a.date !== lastDate) {
        const today = new Date().toISOString().slice(0,10);
        const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
        const dateLabel = a.date===today ? 'Vandaag' : a.date===yesterday ? 'Gisteren' : a.date;
        rows += `<div style="font-size:10px;color:#94a3b8;padding:6px 0 2px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">${dateLabel}</div>`;
        lastDate = a.date;
      }
      const showBy = (effectiveScope==='all' || !a.isOwn) && a.by;
      const byLine = showBy
        ? `<div style="font-size:11px;color:#64748b">${a.by}${a.zone?' · '+a.zone:''}</div>`
        : (a.zone ? `<div style="font-size:11px;color:#94a3b8">${a.zone}</div>` : '');
      rows += `<div data-idx="${idx}" class="al-row" style="display:flex;gap:8px;align-items:flex-start;padding:5px 4px;border-bottom:1px solid #f1f5f9;cursor:${a.marker?'pointer':'default'};border-radius:4px">
        <span style="font-size:15px;flex-shrink:0">${a.icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#1e293b">${a.label}</div>
          ${a.address ? `<div style="font-size:11px;color:#0aa879;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📍 ${a.address}</div>` : ''}
          ${a.note ? `<div style="font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.note}</div>` : ''}
          ${byLine}
        </div>
        <span style="font-size:11px;color:#94a3b8;flex-shrink:0">${a.time}</span>
      </div>`;
    });
    if (hasMore) {
      rows += `<button id="al-more-btn" style="width:100%;margin-top:6px;padding:6px;border-radius:6px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;cursor:pointer;font-size:12px">
        Meer… (${_actionLog.length - ACTION_PAGE_SIZE} meer)</button>`;
    }
    el.innerHTML = headerHtml + rows;
  }

  // Filter knoppen
  el.querySelectorAll('.al-btn').forEach(btn => {
    btn.addEventListener('mouseenter', ()=>{ if(!btn.classList.contains('al-active')) btn.style.background='#f1f5f9'; });
    btn.addEventListener('mouseleave', ()=>{ if(!btn.classList.contains('al-active')) btn.style.background=''; });
    btn.addEventListener('click', () => {
      if (btn.dataset.p) _actionLogPeriod = btn.dataset.p;
      if (btn.dataset.s) { _actionLogScope = btn.dataset.s; }
      _loadActivityLog();
    });
  });

  // Meer knop
  el.querySelector('#al-more-btn')?.addEventListener('click', () => {
    _actionLogShowAll = true;
    _renderActionLog();
  });

  // Klikbare rijen
  el.querySelectorAll('.al-row').forEach(row => {
    const idx = parseInt(row.dataset.idx);
    const a = _actionLog[idx];
    if (!a?.marker) return;
    row.addEventListener('mouseenter', ()=>row.style.background='#f1f5f9');
    row.addEventListener('mouseleave', ()=>row.style.background='');
    row.addEventListener('click', ()=>{
      window._setSidebar?.(false);
      openPropModal({
        type: a.type,
        init: {...a.marker._meta, _latlng: a.marker.getLatLng()},
        onSave:(vals)=>{ applyPropsToMarker(a.marker, vals); persistMarker(a.marker); a.note=vals.note||''; _renderActionLog(); }
      });
    });
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
    // Klik toont eigenschappen altijd — bewerkbaar alleen via contextmenu "Eigenschappen"
    openPropModal({
      type: m.type,
      init: {...m, _latlng: marker.getLatLng()},
      readOnly: true,  // klik = altijd lezen; wijzigen via lang indrukken → Eigenschappen
      onSave: null
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
  // Begrens arc tot max 360 graden om banaan-effect te voorkomen
  const total = Math.max(-360, Math.min(360, endDeg - startDeg));
  const step  = total / steps;
  const pts   = [];
  for(let i=0;i<=steps;i++) pts.push(destinationPoint(center, radius, startDeg+step*i));
  return pts;
}
function registerLine(line){ if(!allLines.includes(line)) allLines.push(line); }
function registerSector(sector){ if(!allSectors.includes(sector)) allSectors.push(sector); }
function makeHandleIcon(){ return L.divIcon({className:'line-handle',html:'<div></div>',iconSize:[12,12],iconAnchor:[6,6]}); }

function _isSectorValid(meta) {
  if (!meta) return false;
  const {bearing, rInner, rOuter, distance} = meta;
  if (isNaN(bearing) || bearing == null) return false;
  if (isNaN(rInner)  || rInner  < 0)    return false;
  if (isNaN(rOuter)  || rOuter  <= 0)   return false;
  if (isNaN(distance)|| distance <= 0)  return false;
  if (rOuter > 50000) return false; // > 50km is sowieso fout
  return true;
}

function createSectorLayer({id, pot, distance, color='#ffcc00', bearing, rInner, rOuter, angleLeft=45, angleRight=45, steps=36, flightId}){
  // Saniteer waarden
  bearing   = ((parseFloat(bearing)  || 0) + 360) % 360;
  rInner    = Math.max(0, Math.min(parseFloat(rInner)  || 0, 49000));
  rOuter    = Math.max(1, Math.min(parseFloat(rOuter)  || 50, 50000));
  distance  = Math.max(1, parseFloat(distance) || 50);
  angleLeft = Math.max(1, Math.min(parseFloat(angleLeft)  || 45, 175));
  angleRight= Math.max(1, Math.min(parseFloat(angleRight) || 45, 175));
  if (rInner >= rOuter) rInner = Math.max(0, rOuter - 25);

  const center = L.latLng(pot.lat, pot.lng);
  const start  = bearing - angleLeft;
  const end    = bearing + angleRight;
  const outer  = arcPoints(center, rOuter, start, end, steps);
  const inner  = arcPoints(center, rInner, end,   start, steps);
  const ring   = [...outer, ...inner];
  const poly   = L.polygon(ring, {color, weight:1, dashArray:'6 6', fillColor:color, fillOpacity:0.25});
  poly._meta   = { id, type:'sector', pot, distance, color, bearing, rInner, rOuter, angleLeft, angleRight, steps, flightId };
  return poly;
}

// ── Verwijder corrupte sectoren (zonder gekoppelde lijn of met ongeldige data) ──
function _cleanupOrphanSectors() {
  const toRemove = [];
  circlesGroup.eachLayer(layer => {
    if (!layer._meta || layer._meta.type !== 'sector') return;
    // Sector zonder gekoppelde lijn
    const linkedLine = allLines.find(l => l._meta?.id === layer._meta?.flightId);
    if (!linkedLine) { toRemove.push(layer); return; }
    // Sector met ongeldige data
    if (!_isSectorValid(layer._meta)) { toRemove.push(layer); return; }
  });
  toRemove.forEach(s => {
    const id = s._meta?.id;
    if (id) deleteSectorFromCloud(id);
    circlesGroup.removeLayer(s);
    const idx = allSectors.indexOf(s);
    if (idx > -1) allSectors.splice(idx, 1);
    console.log('[sector] corrupte sector verwijderd:', id);
  });
  if (toRemove.length > 0) {
    console.log(`[sector] ${toRemove.length} corrupte sector(en) opgeruimd`);
  }
  return toRemove.length;
}

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
  const potLatLng = lokpotMarker.getLatLng();
  _openSightLineModal(potLatLng, (dist, note, color, compassBearing) => {
    const defaultColor = color || '#'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0');

    // Als kompasrichting opgegeven: direct lijn tekenen zonder kaart klik
    if (compassBearing != null && !isNaN(compassBearing)) {
      const brg = ((compassBearing % 360) + 360) % 360;
      const endLatLng = destinationPoint(potLatLng, dist, brg);
      const id = genId('flight');
      const line = L.polyline([potLatLng, endLatLng],{color:defaultColor,weight:3}).addTo(linesGroup);
      line._meta = { id, type:'flight',
        pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:lokpotMarker._meta?.potId||null},
        potId: lokpotMarker._meta?.potId||null, distance:dist, color:defaultColor, bearing:brg, note:note||''
      };
      registerLine(line);
      line._distLabel = L.tooltip({permanent:true,direction:'right',offset:[8,0],className:'line-label'})
        .setContent(`${dist} m`).setLatLng(endLatLng).addTo(map);
      const rInner=Math.max(1,dist-25), rOuter=dist+25;
      const sector = createSectorLayer({
        id:genId('sect'), pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:lokpotMarker._meta?.potId||null},
        distance:dist, color:defaultColor, bearing:brg, rInner, rOuter, angleLeft:45, angleRight:45, steps:36, flightId:id
      }).addTo(circlesGroup);
      registerSector(sector); line._sector=sector; sector._line=line;
      attachSightLineInteractivity(line);
      persistLine(line); persistSector(sector);
      return;
    }

    // Geen kompas: laat gebruiker op kaart klikken voor richting
    const tempGuide = L.polyline([potLatLng,potLatLng],{color:defaultColor,weight:2,dashArray:'4 4'}).addTo(map);
    const onMove = (e) => { tempGuide.setLatLngs([potLatLng,e.latlng]); };
    const onClick = (e) => {
      map.off('mousemove', onMove); map.off('click', onClick); tempGuide.remove();
      const clicked = e.latlng; const brg = bearingBetween(potLatLng, clicked);
      const endLatLng = destinationPoint(potLatLng, dist, brg);
      const id = genId('flight');
      const line = L.polyline([potLatLng, endLatLng],{color:defaultColor,weight:3}).addTo(linesGroup);
      line._meta = { id, type:'flight',
        pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:lokpotMarker._meta?.potId||null},
        potId: lokpotMarker._meta?.potId||null, distance:dist, color:defaultColor, bearing:brg, note:note||''
      };
      registerLine(line);
      line._distLabel = L.tooltip({permanent:true,direction:'right',offset:[8,0],className:'line-label'})
        .setContent(`${dist} m`).setLatLng(endLatLng).addTo(map);
      const rInner=Math.max(1,dist-25), rOuter=dist+25;
      const sector = createSectorLayer({
        id:genId('sect'), pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:lokpotMarker._meta?.potId||null},
        distance:dist, color:defaultColor, bearing:brg, rInner, rOuter, angleLeft:45, angleRight:45, steps:36, flightId:id
      }).addTo(circlesGroup);
      registerSector(sector); line._sector=sector; sector._line=line;
      attachSightLineInteractivity(line);
      persistLine(line); persistSector(sector);
    };
    map.on('mousemove', onMove); map.on('click', onClick);
  });
}

// ── Vliegtijd instelling laden ────────────────────────────────────────────
let _flightSecondsPerMeter = 0.6; // standaard: 4 min (240s) = 400m → 0.6 s/m

async function _loadFlightSettings(zone) {
  try {
    // Probeer eerst zone-specifieke instelling
    if (zone) {
      const zoneSnap = await getDoc(doc(_db, 'config', `settings_${zone}`));
      if (zoneSnap.exists() && zoneSnap.data().secondsPerMeter != null) {
        _flightSecondsPerMeter = parseFloat(zoneSnap.data().secondsPerMeter) || 0.6;
        return;
      }
    }
    // Fallback: globale instelling
    const snap = await getDoc(doc(_db, 'config', 'settings'));
    if (snap.exists() && snap.data().secondsPerMeter != null) {
      _flightSecondsPerMeter = parseFloat(snap.data().secondsPerMeter) || 0.6;
    }
  } catch {}
}

// ── Kompas-kalibratie (per toestel) ───────────────────────────────────────
// Fix 203: elk toestel heeft z'n eigen magnetometer-afwijking, dus dit is bewust
// GEEN globale/gedeelde instelling meer — puur lokaal op dit apparaat (localStorage).
const COMPASS_OFFSET_KEY = 'hornetapp_compass_offset';
function _getCompassOffsetLocal() {
  const v = parseFloat(localStorage.getItem(COMPASS_OFFSET_KEY));
  return isNaN(v) ? 0 : v;
}
function _setCompassOffsetLocal(v) {
  localStorage.setItem(COMPASS_OFFSET_KEY, String(v));
}
const COMPASS_OFFSET_ENABLED_KEY = 'hornetapp_compass_offset_enabled';
function _isCompassOffsetEnabled() {
  const v = localStorage.getItem(COMPASS_OFFSET_ENABLED_KEY);
  return v === null ? true : v === '1'; // standaard AAN
}
function _setCompassOffsetEnabled(on) {
  localStorage.setItem(COMPASS_OFFSET_ENABLED_KEY, on ? '1' : '0');
}

// Huidige schermrotatie t.o.v. de "natuurlijke" stand van het toestel (module-breed herbruikbaar).
function _getScreenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation; // oudere iOS
  return 0;
}

// Doorlopende richtingmeting (géén 3s-gemiddelde): kiest 1 bron en levert live updates,
// voor gebruik in de waaier-kalibratie hieronder. Retourneert een stopfunctie.
function _startLiveHeading(onHeading) {
  let source = null;
  const screenAngle = _getScreenAngle();
  const onIOS = (e) => {
    if (e.webkitCompassHeading == null) return;
    if (source && source !== 'ios') return;
    source = 'ios';
    onHeading(((e.webkitCompassHeading % 360) + 360) % 360);
  };
  const onAbsolute = (e) => {
    if (!e.absolute || e.alpha == null) return;
    if (source && source !== 'absolute') return;
    source = 'absolute';
    onHeading(((360 - e.alpha + screenAngle) % 360 + 360) % 360);
  };
  const onRelative = (e) => {
    if (e.alpha == null) return;
    if (source && source !== 'relative') return;
    source = 'relative';
    onHeading(((360 - e.alpha + screenAngle) % 360 + 360) % 360);
  };
  window.addEventListener('deviceorientation', onIOS, true);
  window.addEventListener('deviceorientationabsolute', onAbsolute, true);
  window.addEventListener('deviceorientation', onRelative, true);
  return function stop() {
    window.removeEventListener('deviceorientation', onIOS, true);
    window.removeEventListener('deviceorientationabsolute', onAbsolute, true);
    window.removeEventListener('deviceorientation', onRelative, true);
  };
}

// Fix 204: draaibare waaier-kalibratie — blauwe waaier toont live waar het toestel nu naar wijst,
// gele pijl sleep je zelf naar de bekende juiste richting; het verschil wordt de opgeslagen correctie.
function openCompassCalibModal(onApplied) {
  const existing = document.getElementById('compass-calib-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'compass-calib-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:18px 20px;width:320px;max-width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)">
      <h3 style="margin:0 0 6px;font-size:15px;color:#0f172a">🧭 Kompas kalibreren</h3>
      <p style="font-size:11.5px;color:#64748b;margin:0 0 12px;line-height:1.5">
        Houd je telefoon plat en richt de bovenkant op een punt waarvan je de richting zeker weet (bv. je garage).
        Sleep de <strong style="color:#b45309">gele pijl</strong> tot die naar datzelfde punt wijst als je telefoon nu ligt.
      </p>
      <svg id="calib-dial" width="230" height="230" viewBox="0 0 230 230" style="touch-action:none;user-select:none;cursor:grab">
        <circle cx="115" cy="115" r="105" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
        <circle cx="115" cy="115" r="70" fill="none" stroke="#e2e8f0" stroke-width="1"/>
        <text x="115" y="24" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">N</text>
        <text x="206" y="120" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">O</text>
        <text x="115" y="212" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">Z</text>
        <text x="24" y="120" text-anchor="middle" font-size="13" fill="#94a3b8" font-weight="600">W</text>
        <g id="calib-live-wedge"><path d="M 115 115 L 98 38 A 19 19 0 0 1 132 38 Z" fill="#3b82f6" opacity="0.45"/></g>
        <g id="calib-target-arrow">
          <line x1="115" y1="115" x2="115" y2="32" stroke="#d97706" stroke-width="4" stroke-linecap="round"/>
          <polygon points="115,17 105,38 125,38" fill="#d97706"/>
        </g>
        <circle cx="115" cy="115" r="7" fill="#0f172a"/>
      </svg>
      <div style="display:flex;justify-content:center;gap:16px;margin-top:6px;font-size:11px;color:#475569">
        <div><span style="display:inline-block;width:10px;height:10px;background:#3b82f6;opacity:.6;border-radius:2px;vertical-align:middle"></span> kompas nu</div>
        <div><span style="display:inline-block;width:10px;height:10px;background:#d97706;border-radius:2px;vertical-align:middle"></span> jouw richting</div>
      </div>
      <div id="calib-diff" style="font-size:16px;font-weight:700;margin-top:10px;color:#0f172a">Correctie: 0°</div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="calib-cancel" style="flex:1;padding:9px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#64748b;font-size:13px;cursor:pointer">Annuleren</button>
        <button id="calib-apply" style="flex:1;padding:9px;border-radius:8px;border:none;background:#0aa879;color:#fff;font-size:13px;font-weight:600;cursor:pointer">Gebruik correctie</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const svg         = modal.querySelector('#calib-dial');
  const liveWedgeEl = modal.querySelector('#calib-live-wedge');
  const targetEl    = modal.querySelector('#calib-target-arrow');
  const diffEl      = modal.querySelector('#calib-diff');

  let liveHeading   = 0;
  let targetHeading = 0; // start bovenaan (noord); gebruiker sleept naar de juiste richting

  function updateDiff() {
    const diff = Math.round(((targetHeading - liveHeading + 540) % 360) - 180);
    diffEl.textContent = `Correctie: ${diff > 0 ? '+' : ''}${diff}°`;
    return diff;
  }
  function renderLive()   { liveWedgeEl.setAttribute('transform', `rotate(${liveHeading} 115 115)`); updateDiff(); }
  function renderTarget() { targetEl.setAttribute('transform', `rotate(${targetHeading} 115 115)`); updateDiff(); }
  renderLive(); renderTarget();

  let stopLive = null;
  function beginLive() { stopLive = _startLiveHeading((h) => { liveHeading = h; renderLive(); }); }
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then(state => { if (state === 'granted') beginLive(); }).catch(() => {});
  } else if (typeof DeviceOrientationEvent !== 'undefined') {
    beginLive();
  }

  // Sleep-interactie: gele pijl volgt vinger/muis rondom het middelpunt.
  function angleFromEvent(ev) {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const p = ev.touches ? ev.touches[0] : ev;
    const x = p.clientX - cx, y = p.clientY - cy;
    const deg = Math.atan2(x, -y) * 180 / Math.PI; // 0° = boven (noord), rechtsom oplopend
    return ((deg % 360) + 360) % 360;
  }
  let dragging = false;
  function onDragStart(ev) { dragging = true; svg.style.cursor = 'grabbing'; onDragMove(ev); ev.preventDefault(); }
  function onDragMove(ev) {
    if (!dragging) return;
    targetHeading = Math.round(angleFromEvent(ev));
    renderTarget();
    ev.preventDefault();
  }
  function onDragEnd() { dragging = false; svg.style.cursor = 'grab'; }
  svg.addEventListener('mousedown', onDragStart);
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('mouseup', onDragEnd);
  svg.addEventListener('touchstart', onDragStart, { passive: false });
  window.addEventListener('touchmove', onDragMove, { passive: false });
  window.addEventListener('touchend', onDragEnd);

  function cleanup() {
    if (stopLive) stopLive();
    svg.removeEventListener('mousedown', onDragStart);
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    svg.removeEventListener('touchstart', onDragStart);
    window.removeEventListener('touchmove', onDragMove);
    window.removeEventListener('touchend', onDragEnd);
    modal.remove();
  }
  modal.querySelector('#calib-cancel').addEventListener('click', cleanup);
  modal.querySelector('#calib-apply').addEventListener('click', () => {
    const diff = updateDiff();
    _setCompassOffsetLocal(diff);
    cleanup();
    onApplied?.();
  });
  modal.addEventListener('click', e => { if (e.target === modal) cleanup(); });
}

// ── Gestylde modal: stopwatch + afstand ──────────────────────────────────
function _openSightLineModal(potLatLng, onConfirm) {
  const existing = document.getElementById('sightline-modal');
  if (existing) existing.remove();
  const secPerM = _flightSecondsPerMeter;
  const defaultSec = 240;
  const defaultDist = Math.round(defaultSec / secPerM);

  const modal = document.createElement('div');
  modal.id = 'sightline-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:12px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:20px 22px;width:340px;max-width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.25)">
      <h3 style="margin:0 0 4px;font-size:16px;color:#0f172a">📐 Zichtlijn toevoegen</h3>
      <p style="font-size:12px;color:#64748b;margin:0 0 12px">Na bevestigen: klik op de kaart voor de richting van het nest</p>

      <!-- Stopwatch blok -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:12px">
        <div style="font-size:12px;font-weight:600;color:#475569;margin-bottom:8px">⏱️ Vliegtijd (heen + terug)</div>
        <div id="sw-display" style="font-size:38px;font-weight:700;color:#0f172a;text-align:center;font-variant-numeric:tabular-nums;letter-spacing:3px;margin-bottom:4px;cursor:pointer;user-select:none" title="Klik om handmatig in te voeren">0:00</div>
        <div id="sw-manual-row" style="display:none;justify-content:center;gap:6px;margin-bottom:8px">
          <input id="sw-min" type="number" min="0" max="59" placeholder="min" style="width:60px;padding:6px;border:1px solid #cbd5e1;border-radius:6px;font-size:15px;text-align:center"/>
          <span style="font-size:18px;color:#64748b;line-height:36px">:</span>
          <input id="sw-sec" type="number" min="0" max="59" placeholder="sec" style="width:60px;padding:6px;border:1px solid #cbd5e1;border-radius:6px;font-size:15px;text-align:center"/>
          <button id="sw-manual-ok" style="padding:6px 12px;border-radius:6px;border:none;background:#0aa879;color:#fff;font-size:13px;cursor:pointer">OK</button>
        </div>
        <div style="display:flex;gap:8px;justify-content:center;margin-bottom:6px">
          <button id="sw-start" style="padding:8px 18px;border-radius:7px;border:none;background:#0aa879;color:#fff;font-size:14px;font-weight:600;cursor:pointer">▶ Start</button>
          <button id="sw-stop"  style="padding:8px 18px;border-radius:7px;border:none;background:#64748b;color:#fff;font-size:14px;cursor:pointer" disabled>⏸ Stop</button>
          <button id="sw-reset" style="padding:8px 12px;border-radius:7px;border:1px solid #cbd5e1;background:#fff;color:#64748b;font-size:13px;cursor:pointer">↺</button>
        </div>
        <div style="font-size:10px;color:#94a3b8;text-align:center">Klik op de tijd om handmatig in te voeren</div>
      </div>

      <!-- Afstand + richting rij -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px">Afstand (m)</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="sl-distance" type="number" min="10" max="5000" value="${defaultDist}"
              style="width:100%;padding:8px 8px;border:1px solid #cbd5e1;border-radius:7px;font-size:16px;font-weight:600;box-sizing:border-box"/>
          </div>
          <button id="sw-apply" style="margin-top:4px;width:100%;padding:6px;border-radius:6px;border:1px solid #0aa879;background:#f0fdf4;color:#0aa879;font-size:11px;cursor:pointer">← Gebruik tijd</button>
        </div>
        <div>
          <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px">Richting (°)</label>
          <input id="sl-bearing" type="number" min="0" max="359" placeholder="0–359"
            style="width:100%;padding:8px 8px;border:1px solid #cbd5e1;border-radius:7px;font-size:16px;font-weight:600;box-sizing:border-box"/>
          <button id="sl-compass" style="margin-top:4px;width:100%;padding:6px;border-radius:6px;border:1px solid #64748b;background:#f8fafc;color:#475569;font-size:11px;cursor:pointer">🧭 Gebruik kompas</button>
          <div style="margin-top:6px">
            <label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#475569;cursor:pointer;margin-bottom:4px">
              <input type="checkbox" id="sl-comp-enabled"/>
              <span>Correctie toepassen</span>
            </label>
            <div style="font-size:10px;color:#94a3b8;margin-bottom:2px;text-align:center">Correctie voor dit toestel</div>
            <div style="display:flex;align-items:center;gap:3px">
              <button type="button" id="sl-comp-m5" style="flex:0 0 auto;padding:5px 7px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-size:11px;cursor:pointer">−5</button>
              <button type="button" id="sl-comp-m1" style="flex:0 0 auto;padding:5px 8px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-size:12px;cursor:pointer">−1</button>
              <div id="sl-comp-val" style="flex:1;text-align:center;font-size:13px;font-weight:600;color:#0f172a">0°</div>
              <button type="button" id="sl-comp-p1" style="flex:0 0 auto;padding:5px 8px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-size:12px;cursor:pointer">+1</button>
              <button type="button" id="sl-comp-p5" style="flex:0 0 auto;padding:5px 7px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-size:11px;cursor:pointer">+5</button>
            </div>
            <button type="button" id="sl-comp-reset" style="margin-top:4px;width:100%;padding:4px;border-radius:5px;border:1px solid #e2e8f0;background:#fff;color:#94a3b8;font-size:10px;cursor:pointer">Reset naar 0°</button>
            <button type="button" id="sl-comp-calib" style="margin-top:5px;width:100%;padding:6px;border-radius:6px;border:1px solid #d97706;background:#fffbeb;color:#b45309;font-size:11px;cursor:pointer">🎯 Nauwkeurig kalibreren (waaier)</button>
          </div>
        </div>
      </div>
      <div style="font-size:10px;color:#94a3b8;margin-top:-6px;margin-bottom:8px">Wil je zien wat het kompas ruw meet, zónder correctie? Zet "Correctie toepassen" uit. Loopt de lijn steeds naar dezelfde kant af? Zet 'm weer aan en stel bij met −/+ of "Nauwkeurig kalibreren" — dit toestel onthoudt de laatste waarde.</div>

      <div id="sl-calc-info" style="font-size:11px;color:#94a3b8;margin-top:-6px;margin-bottom:10px;min-height:14px"></div>

      <!-- Richting label -->
      <div id="sl-bearing-label" style="font-size:12px;color:#0aa879;text-align:center;margin-bottom:10px;min-height:16px"></div>

      <!-- Opmerking -->
      <div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px">Opmerking</label>
        <input id="sl-note" type="text" placeholder="bijv. richting spoor, hoge boom..."
          style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;box-sizing:border-box"/>
      </div>

      <!-- Kleur -->
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:10px">
        <label style="font-size:12px;font-weight:600;color:#475569">Kleur</label>
        <input id="sl-color" type="color" value="#ff6600"
          style="width:40px;height:32px;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;padding:2px"/>
        <span style="font-size:11px;color:#94a3b8">Kleur voor lijn en sector</span>
      </div>

      <div style="display:flex;gap:8px">
        <button id="sl-cancel"  style="flex:1;padding:10px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:14px;color:#475569">Annuleren</button>
        <button id="sl-confirm" style="flex:2;padding:10px;border-radius:8px;border:none;background:#0aa879;color:#fff;cursor:pointer;font-size:14px;font-weight:600">Klik richting op kaart →</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // ── Stopwatch ──────────────────────────────────────────────────────────
  let swInterval=null, swSeconds=0, swRunning=false;
  const display    = modal.querySelector('#sw-display');
  const manualRow  = modal.querySelector('#sw-manual-row');
  const btnStart   = modal.querySelector('#sw-start');
  const btnStop    = modal.querySelector('#sw-stop');
  const btnReset   = modal.querySelector('#sw-reset');
  const btnApply   = modal.querySelector('#sw-apply');
  const distInput  = modal.querySelector('#sl-distance');
  const calcInfo   = modal.querySelector('#sl-calc-info');
  const bearingInp = modal.querySelector('#sl-bearing');
  const bearingLbl = modal.querySelector('#sl-bearing-label');
  const btnCompass = modal.querySelector('#sl-compass');

  // ── Correctie voor dit toestel (Fix 203: lokaal, met werkende +/− knoppen i.p.v. typen) ──
  const compValEl = modal.querySelector('#sl-comp-val');
  const compEnabledEl = modal.querySelector('#sl-comp-enabled');
  function renderCompVal(){
    const v = _getCompassOffsetLocal();
    compValEl.textContent = (v > 0 ? '+' : '') + v + '°';
    compValEl.style.color = _isCompassOffsetEnabled() ? '#0f172a' : '#cbd5e1';
  }
  function bumpCompOffset(delta){
    const v = _getCompassOffsetLocal() + delta;
    _setCompassOffsetLocal(v);
    renderCompVal();
  }
  compEnabledEl.checked = _isCompassOffsetEnabled();
  compEnabledEl.addEventListener('change', () => {
    _setCompassOffsetEnabled(compEnabledEl.checked);
    renderCompVal();
  });
  renderCompVal();
  modal.querySelector('#sl-comp-m5')?.addEventListener('click', () => bumpCompOffset(-5));
  modal.querySelector('#sl-comp-m1')?.addEventListener('click', () => bumpCompOffset(-1));
  modal.querySelector('#sl-comp-p1')?.addEventListener('click', () => bumpCompOffset(1));
  modal.querySelector('#sl-comp-p5')?.addEventListener('click', () => bumpCompOffset(5));
  modal.querySelector('#sl-comp-reset')?.addEventListener('click', () => { _setCompassOffsetLocal(0); renderCompVal(); });
  modal.querySelector('#sl-comp-calib')?.addEventListener('click', () => openCompassCalibModal(renderCompVal));

  function fmtTime(s){ return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
  function updateInfo(secs){
    if(!secs){ calcInfo.textContent=''; return; }
    const d=Math.round(secs/secPerM);
    calcInfo.textContent=`${fmtTime(secs)} = ±${d} m  (${secPerM}s/m)`;
  }
  function bearingToLabel(deg){
    if(deg===''||deg===null||isNaN(deg)) return '';
    const d=((deg%360)+360)%360;
    const dirs=['N','NNO','NO','ONO','O','OZO','ZO','ZZO','Z','ZZW','ZW','WZW','W','WNW','NW','NNW'];
    return `${Math.round(d)}° — ${dirs[Math.round(d/22.5)%16]}`;
  }
  bearingInp.addEventListener('input',()=>{
    bearingLbl.textContent = bearingToLabel(bearingInp.value);
  });

  // Klik op display → handmatige invoer tonen
  display.addEventListener('click',()=>{
    if(swRunning) return;
    const isOpen = manualRow.style.display==='flex';
    manualRow.style.display = isOpen ? 'none' : 'flex';
    if(!isOpen){
      modal.querySelector('#sw-min').value = Math.floor(swSeconds/60)||'';
      modal.querySelector('#sw-sec').value = swSeconds%60||'';
      modal.querySelector('#sw-min').focus();
    }
  });
  modal.querySelector('#sw-manual-ok').addEventListener('click',()=>{
    const m=parseInt(modal.querySelector('#sw-min').value)||0;
    const s=parseInt(modal.querySelector('#sw-sec').value)||0;
    swSeconds=m*60+s;
    display.textContent=fmtTime(swSeconds);
    manualRow.style.display='none';
    updateInfo(swSeconds);
  });

  btnStart.addEventListener('click',()=>{
    if(swRunning) return; swRunning=true;
    btnStart.disabled=true; btnStop.disabled=false;
    swInterval=setInterval(()=>{ swSeconds++; display.textContent=fmtTime(swSeconds); updateInfo(swSeconds); },1000);
  });
  btnStop.addEventListener('click',()=>{
    if(!swRunning) return; swRunning=false; clearInterval(swInterval);
    btnStart.disabled=false; btnStop.disabled=true; btnStart.textContent='▶ Hervat';
  });
  btnReset.addEventListener('click',()=>{
    swRunning=false; clearInterval(swInterval); swSeconds=0;
    display.textContent='0:00'; manualRow.style.display='none';
    btnStart.disabled=false; btnStop.disabled=true; btnStart.textContent='▶ Start';
    calcInfo.textContent='';
  });
  btnApply.addEventListener('click',()=>{
    if(!swSeconds) return;
    distInput.value=Math.round(swSeconds/secPerM);
    updateInfo(swSeconds);
  });
  distInput.addEventListener('input',()=>{
    const d=parseInt(distInput.value);
    if(d>0) calcInfo.textContent=`${d} m → ±${Math.round(d*secPerM)}s vliegtijd`;
    else calcInfo.textContent='';
  });

  // ── Kompas (DeviceOrientationEvent) met middeling ──────────────────────
  // Fix 200: gebruik nog maar 1 bron per meting (i.p.v. absolute+relatief door elkaar),
  // en compenseer voor schermrotatie (portret/liggend) zodat de richting klopt.
  let compassHandler   = null;
  let compassActive    = false;
  let compassReadings  = [];
  let compassTimer     = null;
  let compassSourceUsed = null; // 'ios' | 'absolute' | 'relative'
  const COMPASS_SECS   = 3;

  function circularMean(angles) {
    let sinSum = 0, cosSum = 0;
    for (const a of angles) {
      sinSum += Math.sin(a * Math.PI / 180);
      cosSum += Math.cos(a * Math.PI / 180);
    }
    const mean = Math.atan2(sinSum / angles.length, cosSum / angles.length) * 180 / Math.PI;
    return ((mean % 360) + 360) % 360;
  }

  // Huidige schermrotatie t.o.v. de "natuurlijke" stand van het toestel.
  function getScreenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation; // oudere iOS
    return 0;
  }

  function startCompass(){
    if(compassActive) { stopCompass(); return; }
    const doStart = () => {
      compassActive = true; compassReadings = []; compassSourceUsed = null;
      btnCompass.textContent = `🧭 Meten… ${COMPASS_SECS}s`;
      btnCompass.style.background = '#fef3c7';
      btnCompass.style.borderColor = '#f59e0b';
      bearingLbl.textContent = '🧭 Houd de telefoon plat (horizontaal), bovenkant/camera wijst naar het nest…';
      bearingLbl.style.color = '#f59e0b';

      let remaining = COMPASS_SECS;
      compassTimer = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          btnCompass.textContent = `🧭 Meten… ${remaining}s`;
        } else {
          clearInterval(compassTimer); compassTimer = null;
          if (compassReadings.length > 0) {
            const avg = circularMean(compassReadings);
            const offsetOn = _isCompassOffsetEnabled();
            const offset = offsetOn ? _getCompassOffsetLocal() : 0;
            const h   = Math.round((avg + offset + 360) % 360);
            bearingInp.value = h;
            const offsetTxt = !offsetOn ? ', correctie UIT (ruwe meting)' : (offset ? `, correctie ${offset>0?'+':''}${offset}°` : '');
            bearingLbl.textContent = '✅ ' + bearingToLabel(h) + ` (gem. van ${compassReadings.length} metingen${offsetTxt})`;
            bearingLbl.style.color = '#0aa879';
          } else {
            bearingLbl.textContent = '⚠️ Geen kompasdata ontvangen — kalibreer kompas (8-vorm bewegen) en probeer opnieuw';
            bearingLbl.style.color = '#f59e0b';
          }
          stopCompass();
        }
      }, 1000);

      // Losse handlers per bron: we kiezen de EERSTE bron die data geeft en
      // negeren daarna de andere, zodat metingen niet door elkaar lopen.
      const screenAngle = getScreenAngle();

      const onIOS = (e) => {
        if (e.webkitCompassHeading == null) return;
        if (compassSourceUsed && compassSourceUsed !== 'ios') return;
        compassSourceUsed = 'ios';
        // webkitCompassHeading is al t.o.v. echt noord en houdt al rekening met schermrotatie.
        pushReading(e.webkitCompassHeading);
      };
      const onAbsolute = (e) => {
        if (!e.absolute || e.alpha == null) return;
        if (compassSourceUsed && compassSourceUsed !== 'absolute') return;
        compassSourceUsed = 'absolute';
        let heading = (360 - e.alpha + screenAngle + 360) % 360;
        pushReading(heading);
      };
      const onRelative = (e) => {
        if (e.alpha == null) return;
        // Alleen gebruiken als er geen absolute/iOS-bron actief is (fallback, minder betrouwbaar).
        if (compassSourceUsed && compassSourceUsed !== 'relative') return;
        compassSourceUsed = 'relative';
        let heading = (360 - e.alpha + screenAngle + 360) % 360;
        pushReading(heading);
      };
      function pushReading(heading){
        compassReadings.push(((heading % 360) + 360) % 360);
        const preview = Math.round(circularMean(compassReadings));
        const warn = compassSourceUsed === 'relative' ? ' ⚠️ minder nauwkeurig' : '';
        bearingLbl.textContent = `🧭 ${bearingToLabel(preview)} (${compassReadings.length} metingen…)${warn}`;
      }

      compassHandler = { onIOS, onAbsolute, onRelative };
      window.addEventListener('deviceorientation', onIOS, true);
      window.addEventListener('deviceorientationabsolute', onAbsolute, true);
      window.addEventListener('deviceorientation', onRelative, true);
    };

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(state => {
        if (state === 'granted') doStart();
        else { bearingLbl.textContent = '⚠️ Geen toestemming voor kompas'; bearingLbl.style.color='#f59e0b'; }
      }).catch(() => { bearingLbl.textContent = '⚠️ Kompas niet beschikbaar'; });
    } else if (typeof DeviceOrientationEvent !== 'undefined') {
      doStart();
    } else {
      bearingLbl.textContent = '⚠️ Geen kompas op dit apparaat';
      bearingLbl.style.color = '#f59e0b';
    }
  }

  function stopCompass(){
    if (compassTimer) { clearInterval(compassTimer); compassTimer = null; }
    if (compassHandler) {
      window.removeEventListener('deviceorientation', compassHandler.onIOS, true);
      window.removeEventListener('deviceorientationabsolute', compassHandler.onAbsolute, true);
      window.removeEventListener('deviceorientation', compassHandler.onRelative, true);
      compassHandler = null;
    }
    compassActive = false;
    btnCompass.textContent = '🧭 Gebruik kompas';
    btnCompass.style.background = '#f8fafc';
    btnCompass.style.borderColor = '#64748b';
  }

  btnCompass.addEventListener('click', startCompass);

  // ── Sluiten ───────────────────────────────────────────────────────────
  modal.querySelector('#sl-cancel').addEventListener('click',()=>{
    clearInterval(swInterval); stopCompass(); modal.remove();
  });
  modal.querySelector('#sl-confirm').addEventListener('click',()=>{
    clearInterval(swInterval); stopCompass();
    const dist    = Math.max(10, parseInt(distInput.value)||defaultDist);
    const note    = modal.querySelector('#sl-note').value.trim();
    const color   = modal.querySelector('#sl-color').value || null;
    const bearing = bearingInp.value !== '' ? parseFloat(bearingInp.value) : null;
    modal.remove();
    onConfirm(dist, note, color, bearing);
  });
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
    const _mgrTxt = _mgr ? ` <span style="font-size:11px;color:#64748b;font-weight:normal">(coördinator: ${_mgr})</span>` : '';
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
      if(act==='mk'){
        // Altijd props modal openen bij nieuw icoon — ook binnen polygoon
        openPropModal({
          type: b.dataset.type,
          init: { _latlng: opts.latlng },
          onSave:(vals)=>{
            const m = createMarkerWithPropsAt(opts.latlng, b.dataset.type, vals);
            persistMarker(m);
            _logAction(b.dataset.type, vals, m);
          }
        });
        return;
      }
      if(!opts.polygonLayer) return;
      if(act==='poly_label'){ const lbl=prompt('Polygoon label:', opts.polygonLayer._props?.label||''); if(lbl===null) return; opts.polygonLayer._props.label=lbl; refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }
      else if(act==='poly_color'){ openColorModal(opts.polygonLayer._props?.color||'#0aa879', col=>{ opts.polygonLayer._props.color=col; opts.polygonLayer.setStyle({ color: col, fillColor: col }); refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }); }
      else if(act==='poly_edit'){
        const layer = opts.polygonLayer;
        if(layer.pm?.enabled()) {
          layer.pm.disable();
          if(layer._pmEndEditHandler){ layer.off('dblclick', layer._pmEndEditHandler); layer._pmEndEditHandler=null; }
          persistPolygon(layer);
        } else {
          layer.pm.enable();
          // Fix 201: dubbelklik binnen de polygoon beëindigt het bewerken (i.p.v. alleen via het menu)
          const endEdit = (ev) => {
            L.DomEvent.stopPropagation(ev);
            layer.pm.disable();
            layer.off('dblclick', endEdit);
            layer._pmEndEditHandler = null;
            persistPolygon(layer);
          };
          layer._pmEndEditHandler = endEdit;
          layer.on('dblclick', endEdit);
        }
      }
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
  // Valideer sector data — sla corrupte sectoren over
  if (!doc.pot?.lat || !doc.pot?.lng) return;
  if (!doc.rOuter || doc.rOuter <= 0 || doc.rOuter > 5000) return;
  if (doc.rInner == null || doc.rInner < 0) return;
  if (doc.bearing == null) return;

  const line = allLines.find(l=>l._meta?.id===doc.flightId);
  if(line && line._sector){ circlesGroup.removeLayer(line._sector); }
  const sector = createSectorLayer({
    id: doc.id, pot: doc.pot, distance: doc.distance, color: doc.color, bearing: doc.bearing,
    rInner: doc.rInner, rOuter: doc.rOuter, angleLeft: doc.angleLeft||45, angleRight: doc.angleRight||45, steps: doc.steps||36, flightId: doc.flightId
  }).addTo(circlesGroup);
  registerSector(sector);
  if(line){ line._sector = sector; sector._line = line; }
  else {
    // Wees sector zonder lijn — voeg verwijder contextmenu toe
    sector.on('contextmenu', (e) => {
      e.originalEvent?.preventDefault();
      const el = document.createElement('div'); el.className='ctx-menu';
      el.innerHTML=`<h4>Sector</h4><button data-act="del">🗑️ Verwijderen</button>`;
      el.addEventListener('click', ev => {
        if(ev.target.closest('[data-act="del"]')){
          circlesGroup.removeLayer(sector);
          allSectors = allSectors.filter(s=>s!==sector);
          deleteSectorFromCloud(doc.id);
          closeContextMenu();
        }
      });
      document.body.appendChild(el); contextMenuEl=el;
      positionMenu(el, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
      document.addEventListener('click', closeContextMenuOnce, true);
    });
  }
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

// Zones: worden geladen uit Firestore config/zones — hier de fallback
let ZONE_META = {
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

async function _loadZonesFromFirestore() {
  try {
    const snap = await getDoc(doc(_db, 'config', 'zones'));
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.zones) && data.zones.length) {
        const newMeta = {};
        data.zones.forEach(z => {
          if (z.key) newMeta[z.key] = { label: z.label||z.key, lat: z.lat||52.09, lon: z.lon||5.12, zoom: z.zoom||13 };
        });
        if (Object.keys(newMeta).length) ZONE_META = newMeta;
        console.log('[zones] geladen uit Firestore:', Object.keys(ZONE_META).length, 'zones');
      }
    }
  } catch(e) {
    console.warn('[zones] fallback op hard-coded zones:', e.message);
  }
}
function normalizeZone(z) { return ZONE_ALIAS[z] || z; }
function zoomToZone(zone) {
  const z = normalizeZone(zone);
  const meta = ZONE_META[z];
  if (meta && map) map.flyTo([meta.lat, meta.lon], meta.zoom, { duration: 1 });
}
const ROL_LABEL = {
  admin:     '🔑 Admin',
  manager:   '🗂️ Coördinator',
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
  // Toon status verwijderverzoek in beheer header knop als al ingediend
  const uid2 = auth.currentUser?.uid;
  if (uid2) {
    getDoc(doc(_db, 'roles', uid2)).then(snap => {
      if (snap.data()?.deletionRequested) {
        const adminDelBtn = document.getElementById('admin-request-delete');
        if (adminDelBtn) { adminDelBtn.textContent = '⏳ Verwijdering aangevraagd'; adminDelBtn.disabled = true; }
      }
    }).catch(()=>{});
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
// ======================= Account verwijder-verzoek =======================
async function _requestAccountDeletion() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  // Eigen gestylede modal — geen browser confirm/alert
  return new Promise(resolve => {
    const existing = document.getElementById('delete-account-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'delete-account-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;width:320px;max-width:92vw;box-shadow:0 8px 32px rgba(0,0,0,.25)">
        <div style="font-size:28px;text-align:center;margin-bottom:12px">🗑️</div>
        <h3 style="margin:0 0 8px;font-size:16px;color:#0f172a;text-align:center">Account verwijderen?</h3>
        <p style="font-size:13px;color:#475569;margin:0 0 16px;line-height:1.6">
          Je account wordt gemarkeerd voor verwijdering. Een coördinator verwerkt je verzoek zo snel mogelijk.<br><br>
          Je kaartdata blijft bewaard voor de monitoring.
        </p>
        <div style="display:flex;gap:8px">
          <button id="del-cancel" style="flex:1;padding:10px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:14px;color:#475569">Annuleren</button>
          <button id="del-confirm" style="flex:1;padding:10px;border-radius:8px;border:none;background:#dc2626;color:#fff;cursor:pointer;font-size:14px;font-weight:600">Verwijderen</button>
        </div>
        <div id="del-status" style="font-size:12px;color:#64748b;margin-top:10px;min-height:16px;text-align:center"></div>
      </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#del-cancel').onclick = () => { modal.remove(); resolve(false); };

    modal.querySelector('#del-confirm').onclick = async () => {
      const btn = modal.querySelector('#del-confirm');
      const status = modal.querySelector('#del-status');
      btn.disabled = true; btn.textContent = '⏳ Bezig…';
      try {
        await setDoc(doc(_db, 'roles', uid), {
          deletionRequested: true,
          deletionRequestedAt: new Date().toISOString(),
        }, { merge: true });
        // Toon bevestiging in modal
        modal.querySelector('div > div').innerHTML = `
          <div style="font-size:28px;text-align:center;margin-bottom:12px"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAWCAYAAAAmaHdCAAAE5UlEQVR42l1UWWxUZRT+/v+/987cdkr31k6H1ZalQ+m000gFTBEkBqNFgyNr1Ig2Eh/whaAGvdaIRB80oj4UTcAgEdvIWkQMESpohS7IYl2ILQiF0pZC25m7zF2ODzBGOU/n5Mt3Tr6zMdxlpIEfQy1PxfO7C4g1N7upuPWlmiomOW9YDk4u+qRjc1MsJtg3aytnFahije3SnkEDp+q2dup3J66vj8qrVanKJ7xltkeTHQc7juZ27H3sWlQcKOp02d7nKlaNzxRfCIlhxPAsj+F3IuqxiekyZ64gNwtMzM7LUAr7R+0TlkPrT94wuxqau5OpIgwAXo2V5Ef9aoWqYJItMEFhTMhGcshRfdU2YyvH4kZdNrFBlqGWSoKXSUQ5nDGXSax/xHT2sfNlZYHgNVPk3OwZ+a+E9z54ca1sGyu5bURMm9rGksmmt9/Z99kdmG9bVzGutJ8eTjq4yPSqmRcEg9SbxhdMP362t/H1pbNNv2+H3ydKTcuB5biQOQByYep2l6rry1/ecuTCpWmVwWJf8hABQmzIz5+XpipzcxL2g5OXROyh3MDONEkqGtMt27Yd5jgu8zx4lu06Al5oVFGeeKEk1DNneGS7SFfKTcf9jgHASKS8cRyj+ptZCrZHi5AIqN44SeHEOZKWBcuywAEYgJftEX+6vQ95I0mMkLcl63T3OkYAZ4DXs+i+9slXRyuH8lTsqr1XJBQFiuPCZYAgQsJ1IcV1PNveZ98zZotLGUrLpBNnllAsJsSbAHI2Lq88V5a3wW9acknvTV48OMbOZstIcAYfEWxFhmJZWHXqCoIDOmufkcu/rA7Ja8qn76zYvlvnDCBb2KrfRdqhSBCd4QJWfMPAM2euI0sIGGk+CMPEivY+FA/oaCvJ5Aem5sNne1N6FD2bAcQAgIjYuxuX9kiymGQIeItP9/Ho+QFcG5+JPdEg6jqvInRlFJ3Tc7FvZqGrEvGxUb1r88dHqjUNnGtarcQYI+LisCQ4WDzp7Z+ej66ZhSga0lH//V8IDSXwSzgfB8KFUFyQJAmmqmrz7ZWp5RIw3wNaQZy/b3tUL3PGPUmio9PyWWn/GDLGLMTTZBwaH4BuWl5BepqIJ8zLGEp8SATGWKvLGxoaPE3T+GsNX/3p2d5uNSfAZdP0nmy7iIy4hcGAjEDcwerOfuRyQZbnMH04/nbD561mc3OMAyABAK3HWkHdMXEik30L5i5cffp6UejvW3QqV+FbpmahSJExrfeWXWp5vCMgPtq09eimjvqovOiVI86/B5jalV5M9AerMloU0MJfgwH6tFiFokhM8sneij+GefnlOOC6R9pcvmxOd/dwisdTzuHCWemF0ayDiiQtHFCltv3VITsULGA56enJTEXiu2bkn9TJ24UM/0OVCms5PqE8mwFeEyA4A7yfQjXqA0HaoypiQdyy9xf++Pg8ePx5z0qaVtJU9LjVYblyXfqZ31YkjGSTP025vzoPLR1ToplPAS62Taz1G5XlB2lulPRIeLeGWonotsyN6x6Z8db6xY/GYjEFACgWEzFA6JGyr2luFZlVM1s7otFMGJHyk1RTSUZFuLkRUZkARgDXNI3/7/cS2B2MaaiVjIpwM9VEyIiEz8GIhH9OVISPNSIqsztNThE1TeOaViulBpAaAgGsEVHZiIRbExXhH/4BTRw+aPkvjewAAAAASUVORK5CYII=" width="16" height="16" style="display:inline-block;vertical-align:middle"></div>
          <h3 style="margin:0 0 8px;font-size:16px;color:#0f172a;text-align:center">Verzoek ingediend</h3>
          <p style="font-size:13px;color:#475569;margin:0 0 20px;text-align:center;line-height:1.6">
            Een coördinator verwerkt je verzoek zo snel mogelijk.
          </p>
          <button id="del-close" style="width:100%;padding:10px;border-radius:8px;border:none;background:#0aa879;color:#fff;cursor:pointer;font-size:14px;font-weight:600">Sluiten</button>`;
        modal.querySelector('#del-close').onclick = () => { modal.remove(); };
        const adminDelBtn = document.getElementById('admin-request-delete');
        if (adminDelBtn) { adminDelBtn.textContent = '⏳ Verwijdering aangevraagd'; adminDelBtn.disabled = true; }
        resolve(true);
      } catch(e) {
        btn.disabled = false; btn.textContent = 'Verwijderen';
        status.textContent = 'Mislukt: ' + e.message;
        status.style.color = '#dc2626';
        resolve(false);
      }
    };
  });
}
window._requestAccountDeletion = _requestAccountDeletion;

// ======================= Changelog =======================
// CHANGELOG staat in changelog.js — voeg nieuwe fixes daar bovenaan toe

function openChangelog() {
  const existing = document.getElementById('changelog-modal');
  if (existing) { existing.remove(); return; }

  // Groepeer per categorie
  const cats = {};
  CHANGELOG.forEach(e => {
    if (!cats[e.category]) cats[e.category] = [];
    cats[e.category].push(e);
  });

  const catIcons = { Kaart:'🗺️', Filter:'🔽', Acties:'📋', Overzicht:'📊', GBIF:'🌍', Gebieden:'📍', Account:'👤', Privacy:'🔒', Uiterlijk:'🎨', Algemeen:'ℹ️' };

  let html = '';
  Object.entries(cats).forEach(([cat, entries]) => {
    html += `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${catIcons[cat]||'•'} ${cat}</div>`;
    entries.forEach(e => {
      html += `<div style="padding:8px 10px;background:#f8fafc;border-radius:6px;margin-bottom:4px;border-left:3px solid #0aa879">
        <div style="font-size:12px;color:#94a3b8;margin-bottom:2px">${e.version}</div>
        <div style="font-size:13px;color:#1e293b;line-height:1.5">${e.text}</div>
      </div>`;
    });
    html += '</div>';
  });

  const modal = document.createElement('div');
  modal.id = 'changelog-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9100;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45)';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px 16px 0 0;width:100%;max-width:480px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 -4px 32px rgba(0,0,0,.2)">
      <div style="padding:16px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
        <div>
          <div style="font-size:16px;font-weight:700;color:#0f172a">🆕 Verbeteringen</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:2px">Wat is er nieuw in HoornaarZoeken</div>
        </div>
        <button id="changelog-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:#64748b;padding:4px">✕</button>
      </div>
      <div style="overflow-y:auto;padding:16px 20px;flex:1">${html}</div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
  document.getElementById('changelog-close').addEventListener('click', () => modal.remove());

  // Sidebar sluiten op mobiel
  window._setSidebar?.(false);
}

function _showDemoWelcome() {
  const existing = document.getElementById('demo-welcome-modal');
  if (existing) return; // al getoond

  const modal = document.createElement('div');
  modal.id = 'demo-welcome-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9800;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px 26px;width:360px;max-width:100%;box-shadow:0 12px 40px rgba(0,0,0,.3);text-align:center">
      <div style="font-size:48px;margin-bottom:12px">🐝</div>
      <h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">Welkom bij HoornaarZoeken!</h2>
      <div style="display:inline-block;background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;padding:3px 10px;border-radius:12px;margin-bottom:16px">Demo account</div>
      <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 14px;text-align:left">
        Je bent ingelogd met het <strong>demo account</strong>, ingesteld op de gemeenten
        <strong>Wageningen</strong> en <strong>Rhenen</strong>.
      </p>
      <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 14px;text-align:left">
        Je mag alles uitproberen — iconen plaatsen, zichtlijnen tekenen, het overzicht bekijken en filters instellen.
      </p>
      <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 20px;text-align:left">
        💡 <strong>Tip:</strong> lees eerst de <strong>Help</strong> — klik op het
        <span style="background:#f1f5f9;border-radius:4px;padding:1px 6px;font-size:13px">?</span>
        knopje rechtsboven in de app.
      </p>
      <button id="demo-welcome-ok" style="width:100%;padding:13px;border-radius:10px;border:none;background:#0aa879;color:#fff;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.3px">
        Veel plezier met HoornaarZoeken! 🚀
      </button>
      <div style="text-align:center;margin-top:12px;font-size:11px;color:#94a3b8;display:flex;align-items:center;justify-content:center;gap:6px">gemaakt door <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAgGBgcGEAgHBwcJCQgNDgsODg0NDQ0NDRANEQ8WEhEOEBAVGCIbFRYgFxAQHSsdICUlKCgoExstMSwmMCInKCYBCQkJDQsNFQ4OFSYVFRcmJiYnJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJv/AABEIAwAEAAMBEQACEQEDEQH/xAAcAAEBAAMBAQEBAAAAAAAAAAAAAQYHCAUEAwL/xABXEAEAAgECAwMGCAgJCQcCBwAAAQIDBAUGERIHITETIjJBUWEIFEJScYGSsiNicnSCkaGzFRYzNENkc6KxJDVTVGOTwdHSFxglg5Th8ITCNkRGZaPT4v/EABoBAQEBAQEBAQAAAAAAAAAAAAABAgMEBQb/xAAnEQEAAgICAgICAgIDAAAAAAAAAQIDERIhBDETQQUiMlFCcRUzYf/aAAwDAQACEQMRAD8A0N3NsncAAAACcgAUE7gAUADuBO4AAAFAAA7gQF5AdwJ3AAAAcgAO4AFBAUAAAEAAABeQIB3AAvIEBQAAAQFA7gQF7gQFAAAAABAAAAAAXkAAAB3AAAAAAAAcgQF7gQFBO4AAFABO4FA7gO4ADuAAAAAAA7gQFAAABAAOUAoHIE7gXuBAAAAAAAXuBAAIBQQFBAUEAkAFBAUEAAAAAABQQCQAAAAAAAAAAAAAAXmACAAAAAAAAAAAoICggAAAAAAAAAKACAAAAAAAoHMEAAABQQFBAUAAEAAAAAAAAAAAABQQFAABAUEAAAABQQFkEBQQFAABAAAAAAAAAAUAAEABQQAFAABAAAAAAUAAAEkAAFABOQKCcgAAAAAAAAOQHIFBAAUEAABQAAAASQAUAEBQAQFBOQAEAoAIAAAAACggAAAAAAAAKAACAAAoHIEAABQAAAAQAAFBJABQQFAAAABAUAAAAAAE5AAAAoAAIAACgAAkgQCggKCQCggKCAoICggKCAoAEggKAAAAABIIAAAAAACgAAgAALIJAKCQCgAAASCAoICgAAAAgLIJAKAACAAAoJAKCAoICggAAAAKAACAsggKAACAoICgkAoIAACgkAoIAACggKAACAoAAAAAAAAIAACggEgAAoAAAAAICgAgAAAAKAAAAACAAAoAAAAAIAAAAAAAACgAnIFAAAAAAAAABAAUAAAAAAAAAAAAAEBQAASQAAAAAAAAAUAEAABQAAAQAAAAFAABAUAEABQQAAFAAAAkAAAAAAAAACQQFABAAAUACAAQFBAUAEAAABQQFBAUEBQQAAFBAUAAEAAAkAAAAAAAFAAAAAABAUEBQQAAFAAAABAWQQFBAUEBQQAFAABJABZBAAAAAAAUACQQFBAUEAkAFkEAkAFBAUEBQQAAFBAJABQAAQFBAUAAAAAAEBQQAAAAAFAAUARAABQAAAJBAAAAUEBQAQAAFAAABAAUAEAAAABQQFAAAAAAAABJAAAAAABQAAAOYIAAAAAAAACggKCAAAAAoIAACgkgoICggAKCAAAAASACggAAAAAKACAAoAAAAAAAAAAAICggAAAAAAAEAoJCigiAACggKAACAAAAAAoAIAACggKCAAAsggAAAAAALIJAKACSACyCAAASAAAAACggKCQCggAAAAAAAAAAAAKCAAQCggLIIAAAACggAAKCAAAAAoICggAAAAAALIICyCQCggKCAoIBIAKCAsggAAAAAAAAAKCSCqAHJAAAAAABJAAAAAABQQAAAAAFAA5AAgAAAAAAAAAAKCAoIAAAACggAAAAAAKBIIAAAAAAAAAAAAAACgAAAAnIAFBAAAAAAAAAAAAAAAAAUAAEAAAABQQCAUAAAEAABeYIAAAAAAB3AAAAAoJCigIAAAJAKACSAAAAAAAAAAAAAAACggAAAAAAAAAAAAAALIIAAAAAAAAAAAAAAAAAAAAAAAABIAAAEgAoAIAAAAAAAAAAAAAAAAAAABIAKCAAAAAAAAAoIAAAAAAAAAAAAAAAAACgAKAAACAAAACAAoIACggAAAAAAAAKCAAoAIAAAAAACgkgoIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACggAKACAAAAAAAAAAAoIAAAAAAAAAAAAAACggAAAAAAAAAAAAAAAAAAAAAAKAAoAAAiCgAAgKCAAAAAAAAAAAAAAASACggEgAAAAAAAoAIAAAAAAAAABIAAAAAAAAAAAAALIIAACyCAAAAAAAAAAAAAAAAAoJAKCAAAAAAAAASAAAAAABAKCAAAAAAAAAAAAAAAAAAAAoAAAAAAAAAAAIAAAAAAAAAAAAAAAACgAgAAAAAAKCSCggAAAAAAAAKCAoIAAAAAAAAAACggAAAAKACAAAAAAAAAAAAAAAAQCyCAAAAAAdwAKCAAAAAAAoAAAAJIAAAAAAAAAAAAAAAAKAAAABIICggKCAAAAAAAAAAAAAAAAAAAoIAABIAAAAAAAAAKCAAASAAACggEgAAAAAAAAAAASAAABIEAsggAAAAAAAAAAAAAAKCASAAAAACggAKCAAAAAAAAoICgAkgAAAAAAAAAAAAAAASCgAKACAAACAoIAAAAAAAAAAAAAAAAABAKACAAAAAAAAoIAAAAAAAAAAACggAAAAAAAAAAKCAAAAAoICggAAAAAAAAAAAAAAAAKCAAAAAAAoIAAAAAAAABAKACAAAAAAAAAAAAAAAASCgAKACACASACggAALIIAAAAAAAAAAAAAACgAgAAAEgAAAAAAAAAAAsggAAAAAAAAAAAAAAEgAAAAAAAoAEggKCAAAAAAAAAAAAAAAoIAAAAAAAAAAAAAAAACggAAAAAAAAAAAAAAAAAKAAoAIAAIAAAAAAAAAAAAAAAACggAAAAKCAAAAAAAAAAAAAAAAAoIAAAAAAAAAAAAAACggAAAAAAAAAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAIAAAACgAKACCSABIAAAAEAoIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAAAAAAAAAAAAAAAAAAAAAAEgAoIAACggAAAAEgAAAAAAAAAAAAASAAAAAAAAAAAAAAAAAAAAABIAAAAAAKAAAAAACAsAAgAKAACAAAAAAAAAAAAAAAAAoEggAAKCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqgCIAAAKCAAAoJIAAAAAAAAAAAAKCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAAAJIAAEAoIAACggAAAAAAAAAAAAAAAAAAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoChIIgAAAAsggAAKCAAAoIAAAAAAAAAAAAAAAAAAAACggAAAAAAAEASAAAAAAACgAAAgAAAAAAKCSBAEgAAAAAAAAAAAAAAAAAAoIAAAAAAAAAAAAAAAAAAAAAACggAAAAAAAAAAAAAAKCAAAAAQACggAKACAAAoIAACggAALzBAAUEAAAAAAAABQAQAAAAAAFBAAAAAAAAJAgFBAAAAAJAAABQSAWQQAAAAAAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEBQQFkEBZBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAEBQQFBAAAUEBQSQAAAAAAAUAEBQQAAFBAUEAAABQQAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAUEkAAAAFBAAAAAAAAAAUAEAABQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFBAUAEkAFBAJABQASQAWQQAAAAAAFBAUEAABQQFBAJABQQFBAAAAAAAAAAAUEAAAAAAAAAAAAAAAAAAAAAkAFBAJAAAAAAAAAAABZBAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAQAAAAAAAAAAAAAAAAAFAABAAAAAUACQQAAAAAAAFBAAAAAAAAAAAAAAAUEAAAAAAAAAABQQAAAAAAAAAAAAAAAAAAAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEAAABQSAJAAAAAAAAAAAAAAAAkCAWQQFBAAAAAUAAEAkAAAAAFBAAAAAAAAAAAJAAAAABQQAAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEAAAAAAAAAAAAAAAAAAAAAAAAAkACQUABQAQQAAAAAAAAAAAAAAAFABAAAAAAAUEBQQAAAAAFBAAAAAAAAAAAAUEAAAAAAAABQQAAAAAFABJAAABQQAAAAAAAAAAAAAAFABAAAAAAAUEAAAAAAAAAAAAAAAAAAAAABQAQAAFAAUARAAAAAAAAAAAAAAAAAABZBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJAAAAAAABQQCQAAAJABQQAAAAAAAAAAAAAAAAAAFBAUEAABZBIBQQAACQAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQQAAFBAAAAAUEAABQQFBAUEAAAAAAAAkAFBAUAAAEABQAQAAFBJAAAAAAAAAAAAAAAAAAAAAAAABQQFAAABIBQQAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEgCQAAAAAAAAAAAAAWQQFkEAABQQFkEAAAAAAAAAkAFBAWQQFAgAEBQQAAAAFkEAAAAAAAAAAAAAAAAAA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ALIICgAgKACAAcgUAAAEkAAFBJABQAQFBJBQAASQAAAAAAAAAAAAAAAAAAAAAAAAUAAAEgFBAAAAAAAAAAAAAAAAAAAAAAAUEBQQFAVQNEiRBzZak5rtAPQIgAAAKCAAAAAAAAAAAAAAAAKACAAoAIAAAAKCAsggKCASACyCAoICyCAoICyCAoICyCAoAEggKCAsggAAAAAAAAAAAAAAAAAAAAAAAAAKAAoAIAAIAAAAAAAAAAAAAAAAAAAAAACgAAAAAAgKACAAvIEAgFAABAAAAAAAAAAAAAAUAAAAAEAABQQFABAVQAQAAQAAAAFAABAAUAAAEBQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAUAEAEgFBAAAAAUEAAAAAAAAAAAAAABQAASAUEBQQAAFkEAABQQFAABAAIAABQQAAAAAAFAABAWQQFBAAAUEBQQFBFFAQQAAAAAAFABAWQQFBAWQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAABJAAABQQAAAAAAAAAAAAAAAAAFAAABAAAAAAUAAAAAAAAAAAAAEAAAABQAQAAADxBQQAAAAFAABJAAAAAAAAAAAAAAAABQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAABAWQAAQCQAAAJAAAAAAAAAAAAAAAAAAABQAAQCQAUAEABQQFBAUEBZBAUAAAAEAAAAAAAABQQAAAAAAFkEAABZBAAAAAAAAAAAAAUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAFABBJABQASQAAUEBQQFBAAAAAAAAAAAUEAAAgAFAAAABAUAAAAAAAEAAABQAAAQAAAAAAAAAFBAAAAAAAUEkAAFBAAAAAAAAAAAAAAAAAAAUEAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAFCQRAkCAUEBZBAAAJABZBAJAAAAAAAAABQQFkEAABQQFBAWQQFBAUAAEBQQAAAAAAFBIBQQFBAAAAAWQQFBAUEAABQQFkEBQQAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAAAEAAABQASQAAAAAAAAAAUAAEAABQQAAFBAAAAAAUAAAAAEAAAAAAkAACAUAEAAAAAAAgFABAAUAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAAJBAAAAAUEBZBAAAAAAAAAAAAAAAAAAAAAAAAAAAWQSAUAAEAkAAAFBAUEAABQQFBAWQQFkEBQQFBAWQQFBAUEBQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAABAUEAAAAAAAAABQQAAAAAAAAAAAAAAAAAAAFAAAAAABJAABQQAFAABAAAAUAAEAABQQFBAUEAAAABQSQUAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAABAUEgFBAUEAAAABZBAUEAABQSAUEAAAAAABQQAAAAFBAJABQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAABAAAAAAAAAAAAAAAAAAAAAAAAUEAAAAABQAQAAFBAAAAAAAAAUEAAAABQAAQAAAAFBJAAAAAABQQAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAABQQFBAAAUEAAAAAAAAAAAAAAAAAABQQFkEAkAAFBJAAAAABQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAABJAAAAAAAAAAAAAAAAAAAAAAAAAABQQAAAAFBAAAAAAAAAAAAAAAAAAAUEBQQAAFBAAAAAAAUAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAQFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJAAAAAAAAAAAgFBAAAAAUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAAAAQAAAAAAAAAAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEABQQACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJBQAAAQFBAAAAAAAAAAAAAAAAAAAUEAAAAAAAAAAAAAABZBAAAAAAAJABZBAAAWQQAAAAAAAAAAAAAAFkEAABZBAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAAAASQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEAAABQQAAAAAAAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAEgFBAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQQAAAAAAAAAAAAAAAACQAAAWQQAAAAAAAAAAFkEBZBAAAAAAAAAAAUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkFAAUAEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQQFBAAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAFABAkEAAAAAkAAAAAAAAAAAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAUEBZBIBQQAAAAAAAAFBAJAAABZBAAAAAUEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQAFABAkEABQQFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUEABZABJBQAQAAAAAAAAAAAAAAAAAFAAABAUEAAAAAAAAABQSQAAAAAAAAAAAAAAUEAAAAAAAAAAAAAAAAAAAABQAFABBJAAAAAAkAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAUEAABQQFkEBQQAAAAFBAAAAAAAAAAAUEgFkAAEAAAAAAAAAkAFBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUABQAQAQAAAAFABAXkCAoIAAAAAAAAAAAAAAAAACgAgAAAAAAAAAAAAAAAAAAAAAAAAKCAAAAAAAAAoAAAAAIAAAAAAAAACgAgAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoACgAgSCAAAAAoAEggKCASAAAAAAAAAACgSCAAAAAoIAAAAAAAAAAAAAAAAAACggLIIAAAACggAAAAAAAKACAoIBIAKCQBIAKCAAAsggKCAoIBIAEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAAAJIAAAAAKACSAAAAAAAAAAAAAACgkgoAAICgkgAAAAAAAAAAAAAAAAAAA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AKCAAAAAAAAAAAAAoAEKACCSAAAAAAABIAAAAAAAEgAoJAKCAAAAASAAAAAAAAABIAAAAAAAAAAALIIBIALIIAACggKAACAoICggKAACASACgkAoJAKCAsggLIIAAAACyCAsggAAKCKKCIEgAoIABALIIAAAAAAAAAAAAAAAAAABIKAAAACAoIAAACggAAKACSCggAAAKAAAACAoAAAIAAAAAACggAAAAAAAAAAAKCASCggAKAAAAAACAoIAAACgAgKCAAoEggAAKACSCgAAAgKAAAAAAAACASACggAKACcgAAAUAAEAABQQAAAAAAAAFAAAABAAAAAAUEAABQAAAJBAUAAAAAAAAAAACQQAAFkEAAAABZBAAAWQQAAAAAAFBAAIBQAAAAAAAAAQAFAABAAAUAACAQCAUAAEgFAAAAAAAABAUAAEBQQAAFAAkEgCQWAJBAUAAEBZBAWQQFkEAABQQFkEBQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAF5AgKACAoAAAAAAAAAAAAAAAAAAAAACgAAAgAAAAAAAAAAAKACAAoAIAAAAACgAgAAAAAAAAAAAAAAAAAAAKACAAAABIJzBeYAAAAIAAABzBeYJzBQQFBOYKCAoAAAAJzBQQFBOYKCAoJzAABQTmCggAAAAAAKCAAAoAAAAAAICgAAnMFBOYKAABzABOYKCc1ADmC8wTmgoICgnMFBAXmCAoAAIooJzQUEUUE5oKCcwUAABQAQATmABzBQTmABzAABQQFBAUAAEAAUUEQAAUEAB//2Q==" alt="DigiDave" style="height:22px;opacity:0.65;vertical-align:middle"></div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('demo-welcome-ok').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if(e.target === modal) modal.remove(); });
}

async function boot(){
  await _loadZonesFromFirestore();
  await _loadFlightSettings();
  initMap();
  initUIBindings();
  initWakeLock();
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
    _loadFlightSettings(normalizeZone(g)); // herlaad vliegtijd voor nieuwe zone
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
    console.log('[app] zone managers geladen:', Object.keys(_zoneManagers).length, 'zones');
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
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Waarneming — hoornaar gezien"><span style="font-size:15px"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAAWCAYAAADNX8xBAAAE7UlEQVR42m2Ua2wUVRTH/3Nnd2en+6bdbp+0S0voCygPm1I1xVJoFVKwumtiYquf1BCMETRAJMNCDMQoYCsmmvDSGEw3IUQUBERaqLSxYKu25WEp9EW7fWxf2+3OzM5cP7RbS+B+ujfnnN/NOed/DoPZQwHmkGtJjgyaKak0bCDRF7Z7G6cFgHgAFQADgO7ZklGoZRDPEqVvYIr+Uf1Lh4hZ4xPno+KUzBBV81iWnjt8qdcvCCDZ7S7mytCfmzg9Hek3dTZ4vVCeFosaF9i/D0StisBduXF296rYLa4sGAHAnZeY78pPSo/4N+8zZJ+oTNFH3gQABAHE7YVqsoqmB6c0+QDgbRkYsZlMZUHToh+LVqTUaDj+0/DUSAgA7n3NpRmt8uI3U7skQZhhEADweKBSAYzzXaWW0THptFW/EAAvEs6ZsHiFzexIyaRR1h7/hE5DKQzcAmV9c5x0DntBPR6oj9WI0pn7SAMSxE5S0dqsVglnDGtEnYUnLDs6PdTT0T5km+4+Of4GZ1ZbHOWopxSEYWZAJAJiGFCvGySmAH3Hj+ke/lBnXK3TcCZneuap+IWLKwxak7x+Oe/86oQRjnLUC8L/kMdAANCWBQoAe66GTqssH7MoVpsYUNgBCZq6jHijQSOLWQfrJr58WrM0c6nVgGXcUK7vZIt/bdMFEhS5ODgtNTT5hj7WE3KzlPdrgjxblrUh5m5x1kTcix7p55oasG73jAwIpWAikK7v2WKbnVl+t0snhhW5pL4vPJSVnn6hwG73nekWR3kNcgI+JS3OEbb3nyRutxsKFUCoMC+z3hPa3NaDuj0AcLjEdvTbcpMXcBgybIacmaaYFxwtNe2rLjVfAYDbBzTbu4+zJXM1bvnEkMPxqhNaVcrcJl7cUWBOWxZNO1gS3uoLKX3tStxnk5Py2FpN/25Jz0fFWHRnewJ0w85LE5fvVHFFHFSHJGo6yfAoyOi49vfMbeJFALBCOsLpVNrrCzdmZ5CtrhI5/dVnghnrljBl8mi4V5LFIb0sVQHQZLwn/tbXI/8UCJBpzNfRrjzDC99t4umxcnODAzBAm1tRVFiiWJ3Lds266b/ZZKw5+5qZvr+Ce2f+pDIRidd6CsnGtU0NSxdqV94fZ488y/kDgWy+8sGYNYl2jl4rMIS6mx5AP24z3E+O0e2+3TPt6x61Lq1qGRj2ukAIakE8HqjPPX/zFauVX82aokhOcmjCN4m7j6aYSXBTSk6q/EgfhXvDErmxMkn0hQgZt0abHHEOZSsD0LZBMKQ9dkaENktUhSnaBplVL6bEBidMhOjTZNlh8SuK7KOOoB9rzAyNdyaqJMaK6pDWrOgM/FuVKdB76hAmXi+UykLojXb7S8My15ie5N+parl/Wgc0Nzg5HEy2BIctetUwGELsoERu+jRRTWucI2dE8J54u3lhwpL41LkR4QJQVK1x77VH8aW2BWqiqLBtb9+S7vj70WzpR/JgN3K7xmD9K6hcztkcaOqTtMt2nG7dPxbWbouOThh+Yl7oeZjvVetfjyy6z/OR2LiRGawtAj20Chsifv8eYjc/rIJzfiwBACqAnP8inevs0JeJY7geMW5vRN/tcfblLolUfHALl2pcYCkFExhX6jCtXVf/YbRpbjzo7E66KlhSW/ZzRRHwfBsACPM+BYBmgc9r3GXMimzY/wAF5RKYIodq4QAAAABJRU5ErkJggg==" width="16" height="18" style="display:inline-block;vertical-align:middle"></span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Lokpot geplaatst"><span style="font-size:15px"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAl0lEQVR4nGNgGGyAEcbQ0tL6T64h165dY2SijnsYGAafQSwwxps3bygyaBB77dWrV4wMDAwM0/Zt2WJ+LkKZkMaTRivubuiYtIGBgYFh165dg9Brg88gFmyCrPE3uAjqvHwBhcuITc20fVu2EDIHFmMMDAwMu3btmoPVIAYGBgY3N7cUgq5CMghnGO3atWsOsYYwMDAwAABdNimIF3+3ngAAAABJRU5ErkJggg==" width="14" height="18" style="display:inline-block;vertical-align:middle"></span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Nest gevonden"><span style="font-size:15px"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAUCAYAAACEYr13AAAEHElEQVR4nG1TfWiVdRR+zu/33vtuuzndh7rcR21lyECcOtRwOleTUjECuzPa0rJQpKmhyJKE1+u00A38aiFaFBUF12pqMSes2iVRapmlaSmuOS/Zdp1zu7u7u+/X7/THdkWh89/5ep7nwHkI/xMMEBgAAQRwsh56c94sD9xaF+gr299RBwNELetKlhZM0NbHEmhWQuswTb2r4v1QbHSF0Lq5LH8cEjMcRy1NkUI3XTQvPNjxbZKIjq+ZsSw7DXuFkFNSvHLIYh4YTrgjyuUBnVR2mi5dj1fL6Iu7WtxyD6QJeVFIjsIWNyqOnO+jpLxDz0/LykrXcpkdX4ZyOJ41KdeVsnGYce7aIG+vjN0waWL2DNeRBVJTDwumyXFLfUW/T5+eZz/p7S09ct4GAARZ7r/5yg4NWJNwVLZwbc1NJCIu4b23dh7fnSQ865+Xmh6O5tIP5eVaRXu7+8u6Ui1UUDQzTU9tElKUDgzG4DouQIAUAlIwHNP6Hq6qTb147e9NrddNBoSoCIWcYFWVKD1y3rYsay6zUxqNjpger85eXQczYFkOx4YSTto431MJqZVtar1url0720OAIgYEMfi3qgWPlhz7sevzN55p+7dg4tOardhWithVcJVrK0mID8frdjW07DtTOXNKWduFWwwIQYCqb1y14FpJ3q+tL8yrfqnpdOVQf3SzaVvkWKYNSbbPl+LJD/f/sauhZd+J6vmrL5fk/lRfvzIfAAsA8I1Yk3pSvRPCU3M+O12z6LUde07uE467MW2czyM04XkkfOfPmnM9lcdWzK35Jyfj4zsP6XkqMlhESYBBF2ftaLwnkuLhcGHmBy0vzl9Tt7v5UG5XpLMofKdzeVNryalZk5bcnZrz6W1dqkQ0dr2vHxcAgIJBv/T7g6px58ovBLgqZtlWvhR6diS2bfmpq4eRzvTN3KmvRyb69oaFMH2SdMt0927fc7KuvLxcE5cvFzMRMTt8QAhJXoBveuSQbbuLqLt7gC7dvNut01CXchI6oI2MWL29kf5GANTeHnJFIBBQfr9fdvyFn12io4/lZKYUd/efWPHhd8821MwpbK4u27Chqe3weEWr0gWkNRzfeuijM7cNwyCipNEYxAAtbljsC25cVsuFhZPra+YUvlo959LBLUv45MvlWzkzM/3r6oVVAMAGRPIj6Z59DYMQCIAA9WXtssrbGSmne0xbKOJEgUemeHtji1YfbQsZxcXegP+KQwEoBkaZYRhEY6dUZmSIzqLoEzmOOuWYdr49YiJB4pMLj09Zv+XWVasiEHIBwDBAOwJgsGHckzMqbzQ/YFTnvbvtuXfe3rR4nQFDEICg3y/vnzWAB3bBzMQAMYPwP8GAYOYHe1emTcvCGDrfh2gYhggG/XKMlR4AGVPZOXv2+P8AuvrzpeuV45oAAAAASUVORK5CYII=" width="16" height="20" style="display:inline-block;vertical-align:middle"></span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Nest geruimd"><span style="font-size:15px"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAWCAYAAAAmaHdCAAAE5UlEQVR42l1UWWxUZRT+/v+/987cdkr31k6H1ZalQ+m000gFTBEkBqNFgyNr1Ig2Eh/whaAGvdaIRB80oj4UTcAgEdvIWkQMESpohS7IYl2ILQiF0pZC25m7zF2ODzBGOU/n5Mt3Tr6zMdxlpIEfQy1PxfO7C4g1N7upuPWlmiomOW9YDk4u+qRjc1MsJtg3aytnFahije3SnkEDp+q2dup3J66vj8qrVanKJ7xltkeTHQc7juZ27H3sWlQcKOp02d7nKlaNzxRfCIlhxPAsj+F3IuqxiekyZ64gNwtMzM7LUAr7R+0TlkPrT94wuxqau5OpIgwAXo2V5Ef9aoWqYJItMEFhTMhGcshRfdU2YyvH4kZdNrFBlqGWSoKXSUQ5nDGXSax/xHT2sfNlZYHgNVPk3OwZ+a+E9z54ca1sGyu5bURMm9rGksmmt9/Z99kdmG9bVzGutJ8eTjq4yPSqmRcEg9SbxhdMP362t/H1pbNNv2+H3ydKTcuB5biQOQByYep2l6rry1/ecuTCpWmVwWJf8hABQmzIz5+XpipzcxL2g5OXROyh3MDONEkqGtMt27Yd5jgu8zx4lu06Al5oVFGeeKEk1DNneGS7SFfKTcf9jgHASKS8cRyj+ptZCrZHi5AIqN44SeHEOZKWBcuywAEYgJftEX+6vQ95I0mMkLcl63T3OkYAZ4DXs+i+9slXRyuH8lTsqr1XJBQFiuPCZYAgQsJ1IcV1PNveZ98zZotLGUrLpBNnllAsJsSbAHI2Lq88V5a3wW9acknvTV48OMbOZstIcAYfEWxFhmJZWHXqCoIDOmufkcu/rA7Ja8qn76zYvlvnDCBb2KrfRdqhSBCd4QJWfMPAM2euI0sIGGk+CMPEivY+FA/oaCvJ5Aem5sNne1N6FD2bAcQAgIjYuxuX9kiymGQIeItP9/Ho+QFcG5+JPdEg6jqvInRlFJ3Tc7FvZqGrEvGxUb1r88dHqjUNnGtarcQYI+LisCQ4WDzp7Z+ej66ZhSga0lH//V8IDSXwSzgfB8KFUFyQJAmmqmrz7ZWp5RIw3wNaQZy/b3tUL3PGPUmio9PyWWn/GDLGLMTTZBwaH4BuWl5BepqIJ8zLGEp8SATGWKvLGxoaPE3T+GsNX/3p2d5uNSfAZdP0nmy7iIy4hcGAjEDcwerOfuRyQZbnMH04/nbD561mc3OMAyABAK3HWkHdMXEik30L5i5cffp6UejvW3QqV+FbpmahSJExrfeWXWp5vCMgPtq09eimjvqovOiVI86/B5jalV5M9AerMloU0MJfgwH6tFiFokhM8sneij+GefnlOOC6R9pcvmxOd/dwisdTzuHCWemF0ayDiiQtHFCltv3VITsULGA56enJTEXiu2bkn9TJ24UM/0OVCms5PqE8mwFeEyA4A7yfQjXqA0HaoypiQdyy9xf++Pg8ePx5z0qaVtJU9LjVYblyXfqZ31YkjGSTP025vzoPLR1ToplPAS62Taz1G5XlB2lulPRIeLeGWonotsyN6x6Z8db6xY/GYjEFACgWEzFA6JGyr2luFZlVM1s7otFMGJHyk1RTSUZFuLkRUZkARgDXNI3/7/cS2B2MaaiVjIpwM9VEyIiEz8GIhH9OVISPNSIqsztNThE1TeOaViulBpAaAgGsEVHZiIRbExXhH/4BTRw+aPkvjewAAAAASUVORK5CYII=" width="16" height="16" style="display:inline-block;vertical-align:middle"></span></th>
        <th style="text-align:center;padding:3px 4px;cursor:help" title="Val geplaatst"><span style="font-size:15px"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAASCAYAAABSO15qAAADBElEQVR4nHWSzW9bRRTFz70z78Px13Nrp2oLChACQRHtohJI3WSFN2WHxKJLFvGfkKX/AzbsEBI7FGwBQiwjRUhsACkFCREaIaWQBpM2ij/jZ7/3ZuaycNrEqrjS3VzN+c2Zc4cAoAWoNqA+Wqx8teip98sLgVUE5QTQTNKfZjJM0vRp5u59cDrYaQHqQ8ACgBaACLDbFRQWzLR+kgj6k5gjT2NoLCJP09/jqVn2VUgi7wHYeQ1gPAPgvIor78jZpB8nxvgnxqHPjKkTdJlwVrAY50NkwBjdfeDOHWB3FzOAzDx8svIu1ut3uRJFkHiMmBkAEANQAD2JrmD/4e+59a9bevf+faDRADCzAgA4Pf0TRa3lxpWK3KzV8FK1etG1RVzNhW54cny33++/2Wg0smazyXOAIAjYQaRytfq5E5k4AYxz1gtCdPvdHx78+uBja8VorZ9rAICJSFqtlvJ9fzQYDD6bxLEoZhKIg4hTTM4ZNx51ew+LxZJeW7tdBYC9vT167qDX63G73bbpNIlH6fQVv5D/LV8qsQ4DzynmsJhflyifU0pNiORtANRut93cFmbv8HJ+p7f2VuX6lyec9WzKgjjlSBWw5C+9uh0f6Mza0vlpeQFgNCfeYFqLMvM0Kgb/AjnAOULoZVCTte+FcmBklzXzDuBAIpLuH9TjkBdYRGZzYlg3TLXEYq36XwAB7EJP2WxaAnHg4M7nxCywBc/PyFMyt4U5QGIGk5tlpHmfGciI2BCxEaLUh8q9jsJSoVZTs7suATY2NgwAfLv786edx0cD0RSKE4iARECAwAEqBO3nvOANACIi9IKD417PMrEJhG0gZAPM2heWILNx6Vr1dhCGL99aXV0hImk2mzyXwa0g4MTZ6s4NW+12B6lWmmYxCphgr19bDP0D8Q1f6BgAiEgAYHNzMz76p3Pvp0d//HiqbXqUjiYdM5p2zFlymAwn32x/98XhX49+WV5efvYXLsK4XPV6fbVaLofGmIvEU+Dx8WFSrtVyURQ92dra6gCg/wC7P2g7MFcP6gAAAABJRU5ErkJggg==" width="16" height="18" style="display:inline-block;vertical-align:middle"></span></th>
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
      console.log('[app] nieuw account, pending aanmaken');
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
      console.log('[app] pending aangemaakt');
    }

    const data = snap.data();

    // ── PENDING: kaart blokkeren, pending scherm tonen ──────────────────────
    if (!data?.role || data.role === 'pending') {
      // [debug removed]
      _showPendingScreen(email);
      return; // stop hier — geen kaart laden
    }

    // displayName laden
    if (data?.displayName) {
      _currentDisplayName = data.displayName;
    }
    // Rol en zones opslaan — zones eerst herladen zodat nieuwe zones beschikbaar zijn
    _currentRole  = data?.role || '';
    updateHeaderRole(_currentRole, data?.displayName || auth.currentUser?.displayName || '');
    const rawZones = Array.isArray(data?.zones) ? data.zones : [];
    // Zones herladen om nieuwe gebieden mee te nemen, daarna filteren
    await _loadZonesFromFirestore();
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
    // Actie-log laden vanuit Firestore
    _loadActivityLog();
    // Opruimen corrupte sectoren na korte delay zodat alle data geladen is
    setTimeout(() => _cleanupOrphanSectors(), 3000);

    // Demo account welkomstpopup
    const DEMO_EMAIL = 'demo@hoornaarzoeken.nl';
    if ((auth.currentUser?.email || '').toLowerCase() === DEMO_EMAIL) {
      _showDemoWelcome();
    }

    // Zones laden en dropdown vullen, daarna scope activeren
    if (_currentZones.length) {
      const activeZone = _fillZoneDropdown(_currentZones);
      const year = $('sel-year')?.value || DEFAULT_YEAR;
      _loadFlightSettings(activeZone); // laad vliegtijd voor actief gebied
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
  console.log('[app] zone dropdown gevuld:', zones.length, 'zones → actief:', activeZone);
  return activeZone;  // teruggeven zodat aanroeper scope kan activeren
}

export { boot };
