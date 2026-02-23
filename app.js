
const APP_VER = '6.0.9e';
const SW_CACHE = 'hornet-mapper-v6-609e';

/* Map basis */
const map = L.map('map', { zoomControl: true }).setView([52.100, 5.300], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap-bijdragers' }).addTo(map);
map.pm.addControls({ position: 'topleft', drawMarker: false, drawPolyline: false, drawRectangle: true, drawPolygon: true, drawCircle: false, drawCircleMarker: false, editMode: true, dragMode: true, cutPolygon: false, removalMode: true });

/* Statusbar */
const statusSW = document.getElementById('status-sw');
const statusGeo = document.getElementById('status-geo');
const btnSelftest = document.getElementById('btn-selftest');
const btnResetCache = document.getElementById('btn-reset-cache');
function setStatus(el, text, cls){ if(!el) return; el.textContent = text; el.classList.remove('ok','warn','err'); if(cls) el.classList.add(cls); }
function updateSWStatus(){ if(!statusSW) return; const sw=navigator.serviceWorker; const v=APP_VER; const reg=('serviceWorker' in navigator) ? (sw.controller?'actief':'geregistreerd') : 'niet ondersteund'; setStatus(statusSW, `SW:${reg} v${v}`, reg==='niet ondersteund'?'warn':'ok'); }
updateSWStatus();

/* UI refs */
const placeInput = document.getElementById('place-input');
const searchBtn = document.getElementById('search-btn');
const hardDebounceChk = document.getElementById('hard-debounce');
const toggleSidebarBtn = document.getElementById('toggle-sidebar');

/* Debounce */
const SOFT_MS = 180; const HARD_MS = 350; let DEBOUNCE_MS = SOFT_MS; let _lastUiEventTs = 0; function debounceEvent(){ const now=Date.now(); if(now - _lastUiEventTs < DEBOUNCE_MS) return true; _lastUiEventTs = now; return false; } hardDebounceChk?.addEventListener('change', ()=>{ DEBOUNCE_MS = hardDebounceChk.checked ? HARD_MS : SOFT_MS; });

/* Sidebar gedrag + map invalidate fix */
function invalidateMapSoon(){ setTimeout(()=>{ try{ map.invalidateSize(); }catch(_){} }, 150); }
const SIDEBAR_KEY = 'hornet_sidebar_collapsed_v609e';
function applySidebarCollapsed(collapsed){ if(collapsed){ document.body.classList.add('sidebar-collapsed'); } else { document.body.classList.remove('sidebar-collapsed'); } invalidateMapSoon(); }
function shouldAutoCollapse(){ return window.innerWidth <= 900; }
(function initSidebar(){ const saved = localStorage.getItem(SIDEBAR_KEY);
  let coll = (saved === null ? shouldAutoCollapse() : (saved === '1'));
  if(shouldAutoCollapse()) coll = true; // force collapse on small screens
  applySidebarCollapsed(coll);
})();
function setSidebar(coll){ localStorage.setItem(SIDEBAR_KEY, coll?'1':'0'); applySidebarCollapsed(coll); }
toggleSidebarBtn?.addEventListener('click', ()=>{ const isColl = document.body.classList.contains('sidebar-collapsed'); setSidebar(!isColl); });
window.addEventListener('resize', ()=>{ if(shouldAutoCollapse()) setSidebar(true); invalidateMapSoon(); });
window.addEventListener('orientationchange', invalidateMapSoon);
window.addEventListener('load', invalidateMapSoon);

/* Flag: tekenen (polygon) actief? */
let drawing = false;
map.on('pm:drawstart', ()=>{ drawing = true; });
map.on('pm:drawend', ()=>{ drawing = false; });

/* Helpers om NL kleurnaam → hex te mappen (zoals eerder) */
const DUTCH_COLOR_MAP = new Map(Object.entries({ 'rood':'#ff0000','donkerrood':'#8b0000','lichtrood':'#ff6666','kastanjebruin':'#8b4000','bruin':'#8b4513','oranje':'#ffa500','geel':'#ffd700','goud':'#ffd700','citroengeel':'#fff44f','groen':'#008000','donkergroen':'#006400','lichtgroen':'#90ee90','lime':'#32cd32','mintgroen':'#98ff98','blauw':'#0000ff','donkerblauw':'#00008b','lichtblauw':'#87cefa','hemelsblauw':'#87ceeb','cyaan':'#00ffff','turquoise':'#40e0d0','teal':'#008080','paars':'#800080','violet':'#8a2be2','lila':'#c8a2c8','magenta':'#ff00ff','roze':'#ffc0cb','fuchsia':'#ff00ff','grijs':'#808080','lichtgrijs':'#d3d3d3','donkergrijs':'#a9a9a9','antraciet':'#2f4f4f','zilver':'#c0c0c0','zwart':'#000000','wit':'#ffffff'}));
function mapDutchColor(input){ if(!input) return null; const s=String(input).trim().toLowerCase(); if(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s; if(DUTCH_COLOR_MAP.has(s)) return DUTCH_COLOR_MAP.get(s); return s; }

/* Icon helpers */
function makeDivIcon(html, bg = '#1e293b', border = '#334155') { return L.divIcon({ className: 'custom-div-icon', html: `<div style="background:${bg};color:#fff;border:2px solid ${border};border-radius:12px;padding:4px 6px;font-size:14px;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,.3);user-select:none;">${html}</div>`, iconSize: [32, 22], iconAnchor: [16, 11] }); }
const ICONS = { pending: () => makeDivIcon('➕', '#3b3b3b', '#555'), hoornaar: (aantal) => makeDivIcon(`🐝${aantal ? ` x${aantal}` : ''}`, '#933', '#b55'), nest: () => makeDivIcon('🪹', '#445', '#667'), nest_geruimd: () => makeDivIcon('✅', '#264', '#396'), lokpot: () => makeDivIcon('🪤', '#274', '#396') };

/* Lijsten en groepen (vereenvoudigd tov vorige build) */
const polygonsGroup = L.featureGroup().addTo(map);
const markersGroup  = L.featureGroup().addTo(map);
let allMarkers = [];

/* Map clicks: GEEN automatische ➕ meer; open alleen menu als niet aan het tekenen */
map.on('click',(e)=>{
  if (debounceEvent()) return;
  if (drawing || (map.pm?.globalDrawModeEnabled && map.pm.globalDrawModeEnabled())) return;
  openMapContextMenu(e.latlng, e.originalEvent?.clientX??0, e.originalEvent?.clientY??0);
});
map.on('contextmenu',(e)=>{
  if (debounceEvent()) return;
  if (drawing || (map.pm?.globalDrawModeEnabled && map.pm.globalDrawModeEnabled())) return;
  openMapContextMenu(e.latlng, e.originalEvent?.clientX??0, e.originalEvent?.clientY??0);
});

/* Contextmenu minimal */
let contextMenuEl=null;
(function(){ const css=`.ctx-menu{position:fixed;z-index:10000;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:8px;padding:8px;min-width:240px;box-shadow:0 10px 20px rgba(0,0,0,.35);user-select:none}.ctx-menu h4{margin:4px 8px 6px;font-size:12px;color:#9ca3af;font-weight:600}.ctx-menu button{width:100%;display:flex;gap:8px;background:transparent;color:inherit;border:0;text-align:left;padding:8px 10px;border-radius:6px;font-size:14px;cursor:pointer}.ctx-menu button:hover{background:#1f2937}`; const s=document.createElement('style'); s.textContent=css; document.head.appendChild(s); })();
function closeContextMenu(){ if(contextMenuEl){ contextMenuEl.remove(); contextMenuEl=null; } }
function positionMenu(el,x,y){ const pad=6,vw=window.innerWidth,vh=window.innerHeight; el.style.left=Math.min(vw-el.offsetWidth-pad,Math.max(pad,x))+'px'; el.style.top=Math.min(vh-el.offsetHeight-pad,Math.max(pad,y))+'px'; setTimeout(()=>{ const c=()=>closeContextMenu(); document.addEventListener('click',c,{once:true}); window.addEventListener('blur',c,{once:true}); window.addEventListener('resize',c,{once:true}); document.addEventListener('keydown',e=>{ if(e.key==='Escape') c(); },{once:true}); },0); }
function openMapContextMenu(latlng, x, y){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Nieuw icoon</h4>
<button data-type="hoornaar">🐝 Waarneming</button>
<button data-type="nest">🪹 Nest</button>
<button data-type="nest_geruimd">✅ Nest geruimd</button>
<button data-type="lokpot">🪤 Lokpot</button>`; el.addEventListener('contextmenu',e=>e.preventDefault()); el.addEventListener('click',e=>e.stopPropagation()); el.addEventListener('click',ev=>{ const b=ev.target.closest('button'); if(!b) return; const type=b.dataset.type; closeContextMenu(); setTimeout(()=>{ createMarkerWithPropsAt(latlng, type); },0); }); document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); }

/* Maak marker, MAAR alleen als minstens één eigenschap is ingevuld */
function createMarkerWithPropsAt(latlng, type){
  // Eigenschappen uitvragen
  const date = prompt('Datum (YYYY-MM-DD) — leeg laten mag:', ''); if(date===null) return; // cancel
  const by = prompt('Door wie — leeg laten mag:', ''); if(by===null) return;
  let aantal; if(type==='hoornaar'){ const a = prompt('Aantal waarnemingen (optioneel):', ''); if(a===null) return; aantal = a ? (parseInt(a,10)||undefined) : undefined; }
  const hasProp = (date && date.trim()) || (by && by.trim()) || (typeof aantal !== 'undefined');
  if(!hasProp){ alert('Icoon NIET aangemaakt: vul minimaal één eigenschap (datum, door wie of aantal).'); return; }
  // Aanmaken
  const m = placeMarkerAt(latlng, type);
  const meta = m._meta || {}; if(date?.trim()) meta.date = date.trim(); if(by?.trim()) meta.by = by.trim(); if(type==='hoornaar') meta.aantal = aantal; m._meta = meta; attachMarkerPopup(m, true); applyFilters?.();
}

/* Marker plaatsen */
function placeMarkerAt(latlng, type='pending'){ if(!latlng) return null; let marker; if(type==='hoornaar'){ marker=L.marker(latlng,{icon:ICONS.hoornaar()}); marker._meta={type}; } else if(type==='nest'){ marker=L.marker(latlng,{icon:ICONS.nest()}); marker._meta={type}; } else if(type==='nest_geruimd'){ marker=L.marker(latlng,{icon:ICONS.nest_geruimd()}); marker._meta={type}; } else if(type==='lokpot'){ marker=L.marker(latlng,{icon:ICONS.lokpot()}); marker._meta={type,id:`pot_${Date.now()}_${Math.random().toString(36).slice(2)}`}; } else { marker=L.marker(latlng,{icon:ICONS.pending()}); marker._meta={type:'pending'}; }
  marker.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); /* hier kun je later extra menu tonen */ });
  allMarkers.push(marker); markersGroup.addLayer(marker); return marker; }

/* Dummy functies om compile te houden (volledige logica uit eerdere build) */
function attachMarkerPopup(){/* noop voor demo */}
function applyFilters(){/* noop voor demo; markers blijven zichtbaar */}

/* Geocoder test knoppen uit eerdere build weggelaten; focus op gevraagde fixes */
