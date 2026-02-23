
const APP_VER = "6.0.9g";
const SW_CACHE = "hornet-mapper-v6-609g";

/* ===== Map basis ===== */
const map = L.map("map", { zoomControl: true }).setView([52.1, 5.3], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap-bijdragers" }).addTo(map);
map.pm.addControls({ position: "topleft", drawMarker: false, drawPolyline: false, drawRectangle: true, drawPolygon: true, drawCircle: false, drawCircleMarker: false, editMode: true, dragMode: true, cutPolygon: false, removalMode: true });

/* ===== Statusbalk / SW ===== */
const statusSW = document.getElementById("status-sw");
const statusGeo = document.getElementById("status-geo");
const btnSelftest = document.getElementById("btn-selftest");
const btnResetCache = document.getElementById("btn-reset-cache");
function setStatus(el, text, cls){ if(!el) return; el.textContent=text; el.classList.remove("ok","warn","err"); if(cls) el.classList.add(cls);} 
function updateSWStatus(){ if(!("serviceWorker" in navigator)){ setStatus(statusSW, "SW: niet ondersteund", "warn"); return;} const reg = navigator.serviceWorker.controller?"actief":"geregistreerd"; setStatus(statusSW, `SW: ${reg} v${APP_VER}`, "ok"); } updateSWStatus();
btnResetCache.addEventListener("click", async()=>{ try{ if("caches" in window){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); } if("serviceWorker" in navigator){ const regs=await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister())); } localStorage.clear(); alert("Cache & SW gereset. Herladen..."); location.reload(true);}catch(e){ alert("Reset mislukt"); }});

/* ===== Sidebar gedrag ===== */
const toggleSidebarBtn=document.getElementById("toggle-sidebar");
const SIDEBAR_KEY="hornet_sidebar_609g";
function invalidateMap(){ setTimeout(()=>{ try{ map.invalidateSize(); }catch(_){} }, 150); }
function shouldAutoCollapse(){ return window.innerWidth<=900; }
function applySidebarCollapsed(on){ if(on) document.body.classList.add("sidebar-collapsed"); else document.body.classList.remove("sidebar-collapsed"); invalidateMap(); }
(function initSidebar(){ let saved=localStorage.getItem(SIDEBAR_KEY); let coll=saved==="1"; if(shouldAutoCollapse()) coll=true; applySidebarCollapsed(coll); })();
toggleSidebarBtn.addEventListener("click", ()=>{ const isColl=document.body.classList.contains("sidebar-collapsed"); localStorage.setItem(SIDEBAR_KEY, isColl?"0":"1"); applySidebarCollapsed(!isColl); });
window.addEventListener("resize", ()=>{ if(shouldAutoCollapse()) applySidebarCollapsed(true); invalidateMap(); });

/* ===== Debounce (voor menus) ===== */
const SOFT_MS = 150; const HARD_MS = 300; let DEBOUNCE_MS = SOFT_MS; let _lastTs = 0;
function debounceEvent(){ const now=Date.now(); if(now - _lastTs < DEBOUNCE_MS) return true; _lastTs = now; return false; }
const hardDebounceChk=document.getElementById("hard-debounce");
hardDebounceChk?.addEventListener("change", ()=>{ DEBOUNCE_MS = hardDebounceChk.checked ? HARD_MS : SOFT_MS; });

/* ===== Floating search (C2-A) ===== */
const floatingSearchBtn=document.getElementById("floating-search-btn");
const searchOverlay=document.getElementById("search-overlay");
const searchClose=document.getElementById("search-close");
const searchBtn=document.getElementById("search-btn");
const placeInput=document.getElementById("place-input");

floatingSearchBtn.addEventListener("click", ()=>{ searchOverlay.classList.add("active"); searchOverlay.setAttribute("aria-hidden","false"); placeInput.focus(); });
searchClose.addEventListener("click", ()=>{ searchOverlay.classList.remove("active"); searchOverlay.setAttribute("aria-hidden","true"); });
placeInput.addEventListener("keydown", e=>{ if(e.key==="Enter") searchPlaceNL(); });
searchBtn.addEventListener("click", searchPlaceNL);

/* ===== Geocoding ===== */
async function geocodePhoton(q){ const url=`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`; const r=await fetch(url, {headers:{"Accept":"application/json"}}); if(!r.ok) throw new Error("Photon fout"); const j=await r.json(); const f=j?.features?.[0]; if(!f) throw new Error("Geen resultaat"); return {lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0], provider:"photon"}; }
async function geocodeMapsCo(q,key){ const url=`https://geocode.maps.co/search?q=${encodeURIComponent(q)}${key?`&api_key=${encodeURIComponent(key)}`:""}`; const r=await fetch(url, {headers:{"Accept":"application/json"}}); if(!r.ok) throw new Error("maps.co fout"); const j=await r.json(); if(!Array.isArray(j)||j.length===0) throw new Error("Geen resultaat"); const b=j[0]; return {lat:parseFloat(b.lat), lon:parseFloat(b.lon), provider:"maps.co"}; }
async function searchPlaceNL(){ const q=placeInput.value?.trim(); if(!q) return; setStatus(statusGeo, "Geocoder: zoeken...", "warn"); const geocoder=document.getElementById("geocoder-select").value; const key=document.getElementById("mapsco-key").value.trim(); try{ let res; if(geocoder==="photon"){ res=await geocodePhoton(q);} else if(geocoder==="mapsco"){ res=await geocodeMapsCo(q,key);} else { try{ res=await geocodePhoton(q);} catch(e){ res=await geocodeMapsCo(q,key);} } map.setView([res.lat,res.lon], 13); setStatus(statusGeo, `Geocoder: ${res.provider} OK`, "ok"); searchOverlay.classList.remove("active"); searchOverlay.setAttribute("aria-hidden","true"); } catch(e){ console.error(e); alert("Zoeken mislukt of geen resultaat."); setStatus(statusGeo, "Geocoder: fout", "err"); }
}

/* ===== Iconen ===== */
function makeDivIcon(html,bg="#1e293b",border="#334155"){ return L.divIcon({className:"custom-div-icon", html:`<div style="background:${bg};color:#fff;border:2px solid ${border};border-radius:12px;padding:4px 6px;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.3);">${html}</div>`, iconSize:[32,22], iconAnchor:[16,11]}); }
const ICONS={ hoornaar:(a)=>makeDivIcon(`🐝${a?" x"+a:""}`,"#933","#b55"), nest:()=>makeDivIcon("🪹","#445","#667"), nest_geruimd:()=>makeDivIcon("✅","#264","#396"), lokpot:()=>makeDivIcon("🪤","#274","#396"), pending:()=>makeDivIcon("➕","#333","#555") };
const markersGroup=L.featureGroup().addTo(map); let allMarkers=[];

/* ===== Polygoon beheer ===== */
const polygonsGroup=L.featureGroup().addTo(map);
map.on('pm:create', (e)=>{
  const layer=e.layer; if(e.shape==='Polygon' || e.shape==='Rectangle'){ polygonsGroup.addLayer(layer); initPolygon(layer); } else { layer.remove(); }
});

function initPolygon(layer){ layer._props = layer._props || { label:'', color:'#0aa879' };
  const col=layer._props.color || '#0aa879';
  layer.setStyle({ color: col, fillColor: col, fillOpacity: .2, weight: 2 });
  layer.on('contextmenu', (ev)=>{ ev.originalEvent?.preventDefault(); ev.originalEvent?.stopPropagation(); if(debounceEvent()) return; openPolygonContextMenu(layer, ev.originalEvent?.clientX||0, ev.originalEvent?.clientY||0); });
}

function openPolygonContextMenu(layer, x, y){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Polygoon</h4>
<button data-act="label">✏️ Label wijzigen</button>
<button data-act="color">🎨 Kleur wijzigen</button>
<hr/>
<button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click', (ev)=>{ const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act; closeContextMenu(); setTimeout(()=>{ if(act==='label'){ const lbl=prompt('Label:', layer._props?.label||''); if(lbl===null) return; layer._props.label=lbl; } else if(act==='color'){ const col=prompt('Kleur (CSS of hex, bv #ffcc00):', layer._props?.color||'#0aa879'); if(col===null) return; layer._props.color=col; layer.setStyle({ color: col, fillColor: col }); } else if(act==='delete'){ polygonsGroup.removeLayer(layer); }
  },0); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); attachGlobalClose();
}

/* ===== Contextmenu helpers ===== */
let contextMenuEl=null;
function closeContextMenu(){ if(contextMenuEl){ contextMenuEl.remove(); contextMenuEl=null; removeGlobalClose(); } }
function positionMenu(el,x,y){ const pad=6,vw=window.innerWidth,vh=window.innerHeight; el.style.left=Math.min(vw-el.offsetWidth-pad,Math.max(pad,x))+"px"; el.style.top=Math.min(vh-el.offsetHeight-pad,Math.max(pad,y))+"px"; }
function attachGlobalClose(){ document.addEventListener('click', closeContextMenu, { once:true }); document.addEventListener('keydown', escCloseOnce); window.addEventListener('resize', closeContextMenu, { once:true }); }
function removeGlobalClose(){ document.removeEventListener('keydown', escCloseOnce); }
function escCloseOnce(ev){ if(ev.key==='Escape') closeContextMenu(); }

/* ===== Icoon aanmaken met properties ===== */
function createMarkerWithPropsAt(latlng,type){ const date=prompt('Datum (YYYY-MM-DD):',''); if(date===null){ closeContextMenu(); return; }
  const by=prompt('Door wie:',''); if(by===null){ closeContextMenu(); return; }
  let aantal; if(type==='hoornaar'){ const a=prompt('Aantal waarnemingen:',''); if(a===null){ closeContextMenu(); return; } if(a.trim()) aantal=parseInt(a,10)||undefined; }
  const hasProp=(date&&date.trim())||(by&&by.trim())||(aantal!==undefined);
  if(!hasProp){ alert('Minstens één eigenschap (datum/door wie/aantal) vereist.'); closeContextMenu(); return; }
  const m=placeMarkerAt(latlng,type); const meta=m._meta; if(date.trim()) meta.date=date.trim(); if(by.trim()) meta.by=by.trim(); if(type==='hoornaar') meta.aantal=aantal; attachMarkerPopup(m); }

function placeMarkerAt(latlng,type='pending'){ let marker; if(type==='hoornaar'){ marker=L.marker(latlng,{icon:ICONS.hoornaar()}); marker._meta={type}; } else if(type==='nest'){ marker=L.marker(latlng,{icon:ICONS.nest()}); marker._meta={type}; } else if(type==='nest_geruimd'){ marker=L.marker(latlng,{icon:ICONS.nest_geruimd()}); marker._meta={type}; } else if(type==='lokpot'){ marker=L.marker(latlng,{icon:ICONS.lokpot()}); marker._meta={type,id:`pot_${Date.now()}_${Math.random().toString(36).slice(2)}`}; } else { marker=L.marker(latlng,{icon:ICONS.pending()}); marker._meta={type:'pending'}; }
  marker.on('contextmenu',(e)=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(debounceEvent()) return; openMarkerContextMenu(marker, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
  allMarkers.push(marker); markersGroup.addLayer(marker); return marker; }

function openMarkerContextMenu(marker,x,y){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Icoon</h4>
<button data-act="edit">✏️ Eigenschappen</button>
<button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',(ev)=>{ const b=ev.target.closest('button'); if(!b) return; closeContextMenu(); setTimeout(()=>{ if(b.dataset.act==='edit') editMarkerProps(marker); if(b.dataset.act==='delete') deleteMarker(marker); },0); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); attachGlobalClose();
}

function editMarkerProps(marker){ const meta=marker._meta||{}; const date=prompt('Datum (YYYY-MM-DD):', meta.date||''); if(date===null) return; const by=prompt('Door wie:', meta.by||''); if(by===null) return; let aantal; if(meta.type==='hoornaar'){ const a=prompt('Aantal waarnemingen:', meta.aantal||''); if(a===null) return; if(a.trim()) aantal=parseInt(a,10)||undefined; }
  if(date.trim()) meta.date=date.trim(); else delete meta.date; if(by.trim()) meta.by=by.trim(); else delete meta.by; if(meta.type==='hoornaar'){ if(aantal!==undefined) meta.aantal=aantal; else delete meta.aantal; }
  marker._meta=meta; attachMarkerPopup(marker); }

function deleteMarker(marker){ markersGroup.removeLayer(marker); allMarkers = allMarkers.filter(m=>m!==marker); }

function attachMarkerPopup(marker){ const m=marker._meta||{}; let txt=''; if(m.type==='hoornaar'){ txt += m.aantal?`Waarneming (x${m.aantal})`:'Waarneming'; } else if(m.type==='nest'){ txt+='Nest'; } else if(m.type==='nest_geruimd'){ txt+='Nest geruimd'; } else if(m.type==='lokpot'){ txt='Lokpot'; } else { txt='Nieuw icoon'; } if(m.date) txt+=`<br>Datum: ${m.date}`; if(m.by) txt+=`<br>Door: ${m.by}`; marker.bindPopup(txt); }

/* ===== Klikken op kaart: geen auto-icoon, behalve via menu ===== */
let drawing=false; map.on('pm:drawstart',()=>drawing=true); map.on('pm:drawend',()=>drawing=false);
map.on('click',(e)=>{ if(debounceEvent()) return; if(drawing) return; closeContextMenu(); openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
map.on('contextmenu',(e)=>{ if(debounceEvent()) return; if(drawing) return; closeContextMenu(); openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });

/* ===== Map context menu ===== */
function openMapContextMenu(latlng,x,y){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Nieuw icoon</h4>
<button data-type="hoornaar">🐝 Waarneming</button>
<button data-type="nest">🪹 Nest</button>
<button data-type="nest_geruimd">✅ Nest geruimd</button>
<button data-type="lokpot">🪤 Lokpot</button>`;
  el.addEventListener('click',(ev)=>{ const b=ev.target.closest('button'); if(!b) return; closeContextMenu(); createMarkerWithPropsAt(latlng, b.dataset.type); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); attachGlobalClose(); }

/* ===== Filters ===== */
function applyFilters(){ const f={ hoornaar:document.getElementById('f_type_hoornaar').checked, nest:document.getElementById('f_type_nest').checked, nest_geruimd:document.getElementById('f_type_nest_geruimd').checked, lokpot:document.getElementById('f_type_lokpot').checked, pending:document.getElementById('f_type_pending').checked, dateBefore:document.getElementById('f_date_before').value||'' };
  allMarkers.forEach(m=>{ const meta=m._meta||{}; let ok=!!f[meta.type]; if(f.dateBefore && meta.date){ if(meta.date < f.dateBefore) ok=false; } if(ok) markersGroup.addLayer(m); else markersGroup.removeLayer(m); }); }

document.getElementById('apply-filters').addEventListener('click', applyFilters);
document.getElementById('reset-filters').addEventListener('click', ()=>{ document.getElementById('f_type_hoornaar').checked=true; document.getElementById('f_type_nest').checked=true; document.getElementById('f_type_nest_geruimd').checked=true; document.getElementById('f_type_lokpot').checked=true; document.getElementById('f_type_pending').checked=true; document.getElementById('f_date_before').value=''; applyFilters(); });

/* ===== Settings ===== */
const SETTINGS_KEY='hornet_settings_609g';
function saveSettings(){ const d={ geocoder:document.getElementById('geocoder-select').value, mapscoKey:document.getElementById('mapsco-key').value.trim()}; localStorage.setItem(SETTINGS_KEY, JSON.stringify(d)); alert('Instellingen opgeslagen.'); }
document.getElementById('save-settings').addEventListener('click', saveSettings);
(function restore(){ try{ const s=JSON.parse(localStorage.getItem(SETTINGS_KEY))||{}; document.getElementById('geocoder-select').value=s.geocoder||'auto'; document.getElementById('mapsco-key').value=s.mapscoKey||''; }catch{} })();

/* ===== Export/Import ===== */
function exportData(){ const data=allMarkers.map(m=>({ latlng:m.getLatLng(), meta:m._meta })); const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hornet-data.json'; a.click(); }
document.getElementById('export-btn').addEventListener('click', exportData);
document.getElementById('import-file').addEventListener('change', e=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ try{ const list=JSON.parse(r.result); list.forEach(item=>{ const m=placeMarkerAt(item.latlng, item.meta.type); m._meta=item.meta; attachMarkerPopup(m); }); }catch{ alert('Import mislukt'); } }; r.readAsText(f); });

/* ===== Zelftest ===== */
btnSelftest.addEventListener('click', async()=>{ try{ await geocodePhoton('Utrecht'); setStatus(statusGeo, 'Photon OK', 'ok'); }catch{ setStatus(statusGeo, 'Photon NOK', 'err'); }
  const key=document.getElementById('mapsco-key').value.trim(); try{ await geocodeMapsCo('Utrecht', key); setStatus(statusGeo, 'Maps.co OK', 'ok'); }catch{ setStatus(statusGeo, 'Maps.co NOK', 'err'); }
});
