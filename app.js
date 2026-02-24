// app.js — Hornet Mapper NL v6.1.0 (hybride realtime + veilige UI binding)
// ----------------------------------------------------------------------------
// Vereist (door index.html alléén app.js te laden):
// ./sync-engine.js → importeert ./firebase.js → importeert ./config.js
// Leaflet + Geoman (globaal L) moeten vóór app.js geladen zijn.
// 
// Belangrijk: alle DOM‑bindingen pas NA DOMContentLoaded.
// 
// ----------------------------------------------------------------------------
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
  map = L.map('map', { zoomControl: true }).setView([52.1, 5.3], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19, attribution:'© OpenStreetMap-bijdragers'
  }).addTo(map);
  markersGroup.addTo(map);
  linesGroup.addTo(map);
  circlesGroup.addTo(map);
  handlesGroup.addTo(map);
  polygonsGroup.addTo(map);
  // Geoman toolbar
  map.pm.addControls({
    position:'topleft',
    drawMarker:false, drawPolyline:false, drawRectangle:true, drawPolygon:true,
    drawCircle:false, drawCircleMarker:false,
    editMode:true, dragMode:true, cutPolygon:false, removalMode:true
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
  map.on('click', e=>{
    if(shouldDebounce()) return;
    if(drawing) return;
    openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
  map.on('contextmenu', e=>{
    if(shouldDebounce()) return;
    if(drawing) return;
    openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
}
// ======================= UI‑bindingen =======================
function initUIBindings(){
  // Sidebar toggle + mobiel backdrop
  const backdrop = req('sidebar-backdrop');
  function setSidebar(open){
    document.body.classList.toggle('sidebar-collapsed', !open);
    document.body.classList.toggle('sidebar-open', !!open);
    if(backdrop){
      if(open){ backdrop.removeAttribute('hidden'); }
      else { backdrop.setAttribute('hidden',''); }
    }
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
  // 🔍 Zoek overlay
  const floatingSearchBtn = req('floating-search-btn');
  const searchOverlay = req('search-overlay');
  const searchClose = req('search-close');
  const searchBtn = req('search-btn');
  const placeInput = req('place-input');
  on(floatingSearchBtn, 'click', ()=>{
    if(!searchOverlay || !placeInput) return;
    searchOverlay.classList.add('active');
    searchOverlay.setAttribute('aria-hidden','false');
    placeInput.focus();
  });
  on(searchClose, 'click', ()=>{
    if(!searchOverlay) return;
    searchOverlay.classList.remove('active');
    searchOverlay.setAttribute('aria-hidden','true');
  });
  on(placeInput, 'keydown', (e)=>{ if(e.key==='Enter') searchPlaceNL(); });
  on(searchBtn, 'click', searchPlaceNL);
  // Filters
  on(req('apply-filters'), 'click', applyFilters);
  on(req('reset-filters'), 'click', ()=>{
    ['f_type_hoornaar','f_type_nest','f_type_nest_geruimd','f_type_lokpot','f_type_pending']
      .forEach(id => { const el = $(id); if(el) el.checked = true; });
    const fdb = $('f_date_before'); if (fdb) fdb.value = '';
    applyFilters();
  });
  // Zelftest
  on(req('btn-selftest'), 'click', async()=>{
    try{ await geocodePhoton('Utrecht'); setStatus(statusGeo,'Photon OK','ok'); }catch{ setStatus(statusGeo,'Photon NOK','err'); }
    const key = $('mapsco-key')?.value?.trim() || '';
    try{ await geocodeMapsCo('Utrecht', key); setStatus(statusGeo,'Maps.co OK','ok'); }catch{ setStatus(statusGeo,'Maps.co NOK','err'); }
  });
  // Cache reset
  on(req('btn-reset-cache'), 'click', async()=>{
    try{
      if('caches' in window){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); }
      if('serviceWorker' in navigator){ const regs=await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister())); }
      localStorage.clear(); alert('Cache & SW gereset. Herladen…'); location.reload(true);
    }catch{ alert('Reset mislukt'); }
  });
  updateSWStatus();
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
  const r=await fetch(`https://geocode.maps.co/search?q=${encodeURIComponent(q)}${key?`&api_key=${encodeURIComponent(key)}`:''}`,
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

// === r2.1: NL kleurnamen toestaan ===
const DUTCH_COLOR_MAP = {
  rood:'red', blauw:'blue', geel:'yellow', groen:'green',
  oranje:'orange', paars:'purple', zwart:'black', wit:'white',
  grijs:'gray', magenta:'magenta', cyaan:'cyan',
  bruin:'brown', roze:'pink',
  lichtblauw:'#ADD8E6', donkerblauw:'#00008B',
  lichtgroen:'#90EE90', donkergroen:'#006400'
};
function normalizeColor(input){
  if(!input) return input;
  const c = String(input).trim().toLowerCase();
  if (c.startsWith('#') || c.startsWith('rgb') || c.startsWith('hsl')) return input;
  return DUTCH_COLOR_MAP[c] || input;
}
// ======================= Iconen =======================
function makeDivIcon(html,bg='#1e293b',border='#334155'){
  return L.divIcon({
    className:'custom-div-icon',
    html:`<div style="background:${bg};color:#fff;border:2px solid ${border};border-radius:12px;padding:4px 6px;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.3);">${html}</div>`,
    iconSize:[32,22], iconAnchor:[16,11]
  });
}
const ICONS = {
  hoornaar:(a)=>makeDivIcon(`🐝${a?` x${a}`:''}`,'#933','#b55'),
  nest:()=>makeDivIcon('🪹','#445','#667'),
  nest_geruimd:()=>makeDivIcon('✅','#264','#396'),
  lokpot:()=>makeDivIcon('🪤','#274','#396'),
  pending:()=>makeDivIcon('➕','#333','#555')
};
// ======================= Contextmenu infra =======================
let contextMenuEl=null;
function closeContextMenu(){
  if(contextMenuEl){
    contextMenuEl.remove(); contextMenuEl=null;
    document.removeEventListener('keydown', escClose);
    document.removeEventListener('click', closeContextMenuOnce, true);
  }
}
function positionMenu(el,x,y){
  const pad=6,vw=window.innerWidth,vh=window.innerHeight;
  el.style.left=Math.min(vw-el.offsetWidth-pad,Math.max(pad,x))+'px';
  el.style.top =Math.min(vh-el.offsetHeight-pad,Math.max(pad,y))+'px';
}
function escClose(e){ if(e.key==='Escape') closeContextMenu(); }
function closeContextMenuOnce(){ closeContextMenu(); }
function openMapContextMenu(latlng, x, y){
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
  <button data-act="edit">✏️ Eigenschappen</button>
  ${isLokpot?'<button data-act="new_line">📐 Zichtlijn toevoegen</button>':''}
  <button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    setTimeout(()=>{
      if(act==='edit'){
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
  const el=document.createElement('div'); el.className='ctx-menu';
  el.innerHTML=`<h4>Zichtlijn</h4>
  <button data-act="color">🎨 Kleur bewerken</button>
  <button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    if(act==='delete'){ deleteSightLine(line,true); }
    else if(act==='color'){ openLineColorPicker(line, x, y); }
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y);
  document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}
function openLineColorPicker(line, x, y){
  closeContextMenu();
  const curr=line._meta?.color||'#ffcc00';
  const el=document.createElement('div'); el.className='ctx-menu';
  el.innerHTML=`<h4>Lijnkleur</h4>
  <input id="lc_hex" type="color" value="${curr}" style="width:100%;height:36px;border:0;background:transparent" />
  <div class="actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
  <button data-act="cancel" class="btn-secondary">Annuleren</button>
  <button data-act="save" class="btn-primary">Opslaan</button>
  </div>`;
  el.addEventListener('click',ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    if(act==='cancel'){ closeContextMenu(); return; }
    if(act==='save'){ const color=el.querySelector('#lc_hex').value; setSightLineColor(line,color,true); closeContextMenu(); }
  });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y);
  document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}
// ======================= Modal (icon properties) =======================
const modalEl = $('prop-modal');
const pmDate = $('pm-date');
const pmBy = $('pm-by');
const pmAmount= $('pm-amount');
const pmSave = $('pm-save');
const pmCancel= $('pm-cancel');
function openPropModal({type, init={}, onSave}){
  if(!modalEl){ console.warn('[UI] prop-modal ontbreekt'); return; }
  if(pmDate) pmDate.value = init.date || nowISODate();
  if(pmBy) pmBy.value = init.by || '';
  const onlyH = document.querySelector('.only-hoornaar');
  if(onlyH) onlyH.style.display = (type==='hoornaar' ? 'grid' : 'none');
  if(type==='hoornaar' && pmAmount) pmAmount.value = (init.aantal!=null? init.aantal : '');
  modalEl.classList.remove('hidden');
  function cleanup(){ if(pmCancel) pmCancel.onclick=null; if(pmSave) pmSave.onclick=null; modalEl.classList.add('hidden'); }
  if(pmCancel) pmCancel.onclick = ()=>cleanup();
  if(pmSave) pmSave.onclick = ()=>{
    const vals={ date: pmDate?.value || nowISODate(), by: pmBy?.value || '' };
    if(type==='hoornaar' && pmAmount){ const a=parseInt(pmAmount.value,10); if(!isNaN(a)) vals.aantal=a; }
    onSave && onSave(vals); cleanup();
  };
}
// ======================= Marker workflow =======================
function attachMarkerPopup(marker){
  const m=marker._meta||{}; let txt='';
  if(m.type==='hoornaar'){ txt+= m.aantal?`Waarneming (x${m.aantal})`:'Waarneming'; }
  else if(m.type==='nest'){ txt+='Nest'; }
  else if(m.type==='nest_geruimd'){ txt+='Nest geruimd'; }
  else if(m.type==='lokpot'){ txt='Lokpot'; }
  else { txt='Nieuw icoon'; }
  if(m.date) txt+=`<br>Datum: ${m.date}`; if(m.by) txt+=`<br>Door: ${m.by}`;
  marker.bindPopup(txt);
}
function applyPropsToMarker(marker, vals){
  const m=marker._meta||{};
  if(vals.date) m.date=vals.date; else delete m.date;
  if(vals.by) m.by=vals.by; else delete m.by;
  if(m.type==='hoornaar'){ if(vals.aantal!=null) m.aantal=vals.aantal; else delete m.aantal; marker.setIcon(ICONS.hoornaar(m.aantal)); }
  else if(m.type==='nest'){ marker.setIcon(ICONS.nest()); }
  else if(m.type==='nest_geruimd'){ marker.setIcon(ICONS.nest_geruimd()); }
  else if(m.type==='lokpot'){ marker.setIcon(ICONS.lokpot()); }
  marker._meta=m; attachMarkerPopup(marker);
}
function placeMarkerAt(latlng, type='pending'){
  const id = genId('mk'); let marker;
  if(type==='hoornaar'){ marker=L.marker(latlng,{icon:ICONS.hoornaar()}); marker._meta={id,type}; }
  else if(type==='nest'){ marker=L.marker(latlng,{icon:ICONS.nest()}); marker._meta={id,type}; }
  else if(type==='nest_geruimd'){ marker=L.marker(latlng,{icon:ICONS.nest_geruimd()}); marker._meta={id,type}; }
  else if(type==='lokpot'){ const potId=genId('pot'); marker=L.marker(latlng,{icon:ICONS.lokpot()}); marker._meta={id,type,potId}; }
  else { marker=L.marker(latlng,{icon:ICONS.pending()}); marker._meta={id,type:'pending'}; }
  marker.on('contextmenu',e=>{
    e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation();
    if(shouldDebounce()) return;
    openMarkerContextMenu(marker, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0);
  });
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
    potId:m.potId||null
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
    if(line.getTooltip()) line.setTooltipContent(`${dist} m`);
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
    line.bindTooltip(`${dist} m`,{permanent:true,direction:'center',className:'line-label'});
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
  if(lbl){
    const pos = polygonCentroid(layer);
    if(!layer._labelTooltip){
      layer._labelTooltip = L.tooltip({permanent:true,direction:'center',className:'poly-label'}).setContent(lbl).setLatLng(pos);
      layer._labelTooltip.addTo(map);
    } else {
      layer._labelTooltip.setContent(lbl).setLatLng(pos);
    }
    const el = layer._labelTooltip.getElement(); if(el) el.style.borderColor = col;
  } else {
    if(layer._labelTooltip){ map.removeLayer(layer._labelTooltip); layer._labelTooltip=null; }
  }
}
function initPolygon(layer){
  layer._props = layer._props || { id: genId('poly'), label:'', color:'#0aa879' };
  const col = layer._props.color||'#0aa879';
  layer.setStyle({ color: col, fillColor: col, fillOpacity: .2, weight: 2 });
  refreshPolygonLabel(layer);
  const open = (ev)=>{
    ev.originalEvent?.preventDefault(); ev.originalEvent?.stopPropagation();
    if(shouldDebounce()) return;
    openUnifiedContextMenu({ x:ev.originalEvent?.clientX||0, y:ev.originalEvent?.clientY||0, latlng:ev.latlng, polygonLayer: layer });
  };
  layer.on('contextmenu', open); layer.on('click', open);
}
function persistPolygon(layer){
  const id = layer._props?.id || genId('poly'); layer._props.id = id;
  const latlngs = layer.getLatLngs().flat(3).map(p=>({lat:p.lat,lng:p.lng}));
  const doc = { id, label:layer._props.label||'', color:layer._props.color||'#0aa879', latlngs };
  savePolygonToCloud(doc);
}
// ======================= Unified contextmenu =======================
function openUnifiedContextMenu(opts){
  closeContextMenu();
  const el=document.createElement('div'); el.className='ctx-menu';
  let html='';
  if(opts.polygonLayer){
    html += `<h4>Polygoon</h4>
    <button data-act="poly_label">✏️ Label wijzigen</button>
    <button data-act="poly_color">🎨 Kleur wijzigen</button>
    <button data-act="poly_edit">✍️ Vorm bewerken aan/uit</button>
    <button data-act="poly_delete">🗑️ Verwijderen</button>
    <hr/>`;
  }
  html += `<h4>Nieuw icoon</h4>
  <button data-act="mk" data-type="hoornaar">🐝 Waarneming</button>
  <button data-act="mk" data-type="nest">🪹 Nest</button>
  <button data-act="mk" data-type="nest_geruimd">✅ Nest geruimd</button>
  <button data-act="mk" data-type="lokpot">🪤 Lokpot</button>`;
  el.innerHTML=html;
  el.addEventListener('click', ev=>{
    const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act;
    closeContextMenu();
    setTimeout(()=>{
      if(act==='mk'){ const m=createMarkerWithPropsAt(opts.latlng, b.dataset.type, {date:nowISODate()}); persistMarker(m); return; }
      if(!opts.polygonLayer) return;
      if(act==='poly_label'){ const lbl=prompt('Polygoon label:', opts.polygonLayer._props?.label||''); if(lbl===null) return; opts.polygonLayer._props.label=lbl; refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }
      else if(act==='poly_color') {
  let col = prompt('Kleur (NL/ENG/hex):', opts.polygonLayer._props?.color || '#0aa879');
  if (col === null) return;
  col = normalizeColor(col);
  opts.polygonLayer._props.color = col;
  opts.polygonLayer.setStyle({ color: col, fillColor: col });
  refreshPolygonLabel(opts.polygonLayer);
  persistPolygon(opts.polygonLayer);
}
); refreshPolygonLabel(opts.polygonLayer); persistPolygon(opts.polygonLayer); }
      else if(act==='poly_edit'){ const enabled = opts.polygonLayer.pm?.enabled(); if(enabled) opts.polygonLayer.pm.disable(); else opts.polygonLayer.pm.enable(); }
      else if(act==='poly_delete'){ const id=opts.polygonLayer._props?.id; if(id){ deletePolygonFromCloud(id); } polygonsGroup.removeLayer(opts.polygonLayer); }
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
  dateBefore: $('f_date_before')?.value || ''
};}
function applyFilters(){
  const f=getActiveFilters();
  allMarkers.forEach(m=>{
    const meta=m._meta||{}; let show=!!f[meta.type];
    if(f.dateBefore && meta.date){ if(meta.date < f.dateBefore) show=false; }
    if(show) markersGroup.addLayer(m); else markersGroup.removeLayer(m);
  });
  const visiblePotIds=new Set();
  allMarkers.forEach(m=>{ const meta=m._meta||{}; if(meta.type==='lokpot' && markersGroup.hasLayer(m)) visiblePotIds.add(meta.potId); });
  allLines.forEach(line=>{
    const meta=line._meta||{}; const should = visiblePotIds.has(meta.potId);
    const onMap = linesGroup.hasLayer(line);
    if(should && !onMap) linesGroup.addLayer(line);
    if(!should && onMap) linesGroup.removeLayer(line);
    if(line._handle){
      const showH = should; const inH = handlesGroup.hasLayer(line._handle);
      if(showH && !inH) handlesGroup.addLayer(line._handle);
      if(!showH && inH) handlesGroup.removeLayer(line._handle);
    }
    if(line._sector){
      const showS = should; const inS = circlesGroup.hasLayer(line._sector);
      if(showS && !inS) circlesGroup.addLayer(line._sector);
      if(!showS && inS) circlesGroup.removeLayer(line._sector);
    }
  });
}
// ======================= Cloud → kaart (realtime) =======================
function upsertMarkerFromCloud(doc){
  // zoek bestaande marker
  let m = allMarkers.find(x=>x._meta?.id===doc.id);
  if(!m){
    m = L.marker([doc.lat, doc.lng], { icon: (()=>{
      if(doc.type==='hoornaar') return ICONS.hoornaar(doc.aantal);
      if(doc.type==='nest') return ICONS.nest();
      if(doc.type==='nest_geruimd') return ICONS.nest_geruimd();
      if(doc.type==='lokpot') return ICONS.lokpot();
      return ICONS.pending();
    })() });
    m._meta = { id: doc.id, type: doc.type, potId: doc.potId||null, date: doc.date||null, by: doc.by||null, aantal: doc.aantal!=null? doc.aantal:null };
    m.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(shouldDebounce()) return; openMarkerContextMenu(m, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
    allMarkers.push(m); markersGroup.addLayer(m);
  } else {
    m.setLatLng([doc.lat, doc.lng]);
    m._meta.type = doc.type;
    m._meta.potId = doc.potId||null;
    m._meta.date = doc.date||null;
    m._meta.by = doc.by||null;
    m._meta.aantal = (doc.aantal!=null? doc.aantal:null);
    if(doc.type==='hoornaar') m.setIcon(ICONS.hoornaar(m._meta.aantal));
    if(doc.type==='nest') m.setIcon(ICONS.nest());
    if(doc.type==='nest_geruimd') m.setIcon(ICONS.nest_geruimd());
    if(doc.type==='lokpot') m.setIcon(ICONS.lokpot());
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
    l.bindTooltip(`${doc.distance||0} m`,{permanent:true,direction:'center',className:'line-label'});
    attachSightLineInteractivity(l);
  } else {
    l.setLatLngs(latlngs);
    l._meta = { ...l._meta, ...doc };
    if(l.getTooltip()) l.setTooltipContent(`${doc.distance||0} m`);
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
  if(p){ polygonsGroup.removeLayer(p); }
  const latlngs = (doc.latlngs||[]).map(pt=>L.latLng(pt.lat,pt.lng));
  const lp = L.polygon(latlngs).addTo(polygonsGroup);
  lp._props = { id: doc.id, label: doc.label||'', color: doc.color||'#0aa879' };
  initPolygon(lp);
}
function deletePolygonFromCloudLocal(id){
  const p = polygonsGroup.getLayers().find(x=>x._props?.id===id);
  if(p){ polygonsGroup.removeLayer(p); }
}
// ======================= Scope & opstart =======================
const LS_SCOPE = "hornet_scope_v610"; // {year, group}
const DEFAULT_YEAR = String(new Date().getFullYear());
const DEFAULT_GROUP = "Hoornaar_Zeist";
function readScope(){ try{ return JSON.parse(localStorage.getItem(LS_SCOPE))||null; }catch{return null;} }
function writeScope(year, group){ localStorage.setItem(LS_SCOPE, JSON.stringify({year,group})); }
function activateScope(year, group, reload=false){
  const { base } = setActiveScope(year, group);
  writeScope(year, group);
  // Realtime listeners
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
    markersGroup.clearLayers(); linesGroup.clearLayers(); circlesGroup.clearLayers(); handlesGroup.clearLayers(); polygonsGroup.clearLayers();
    allMarkers=[]; allLines=[]; allSectors=[];
  }
  setStatus(statusSW, `Scope: ${base}`, 'ok');
}
// ======================= DOMContentLoaded: alles starten =======================
function boot(){
  initMap();
  initUIBindings();
  const selYear = $('sel-year');
  const selGroup = $('sel-group');
  const saved = readScope() || { year: DEFAULT_YEAR, group: DEFAULT_GROUP };
  if(selYear && ![...selYear.options].some(o=>o.value===saved.year)){
    selYear.insertAdjacentHTML('afterbegin', `<option value="${saved.year}">${saved.year}</option>`);
  }
  if(selYear) selYear.value = saved.year;
  if(selGroup) selGroup.value = saved.group;
  on(req('apply-scope'), 'click', ()=>{
    const y = selYear?.value || DEFAULT_YEAR;
    const g = selGroup?.value || DEFAULT_GROUP;
    activateScope(y, g, /*reload=*/true);
  });
  activateScope(saved.year, saved.group, /*reload=*/true);
  applyFilters();
}
if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
