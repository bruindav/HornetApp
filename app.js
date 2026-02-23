
// Hornet Mapper NL — 6.0.9j-R2
const APP_VER = '6.0.9j-R2';
const SW_CACHE = 'hornet-mapper-v6-609j-r2';

// ===== Map =====
const map = L.map('map', { zoomControl: true }).setView([52.1, 5.3], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap-bijdragers' }).addTo(map);
map.pm.addControls({ position:'topleft', drawMarker:false, drawPolyline:false, drawRectangle:true, drawPolygon:true, drawCircle:false, drawCircleMarker:false, editMode:true, dragMode:true, cutPolygon:false, removalMode:true });

// ===== Status/SW =====
const statusSW = document.getElementById('status-sw');
const statusGeo = document.getElementById('status-geo');
function setStatus(el, text, cls){ if(!el) return; el.textContent=text; el.classList.remove('ok','warn','err'); if(cls) el.classList.add(cls); }
function updateSWStatus(){ if(!('serviceWorker' in navigator)){ setStatus(statusSW, 'SW: niet ondersteund', 'warn'); return; } const st = navigator.serviceWorker.controller ? 'actief' : 'geregistreerd'; setStatus(statusSW, `SW: ${st} v${APP_VER}`, 'ok'); }
updateSWStatus();

document.getElementById('btn-reset-cache').addEventListener('click', async()=>{
  try{ if('caches' in window){ const ks=await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); }
       if('serviceWorker' in navigator){ const regs=await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister())); }
       localStorage.clear(); alert('Cache & SW gereset. Herladen…'); location.reload(true);
  }catch(e){ alert('Reset mislukt'); }
});

// ===== Sidebar toggle =====
const toggleSidebarBtn=document.getElementById('toggle-sidebar');
const SIDEBAR_KEY='hornet_sidebar_609j-r2';
function invalidateMap(){ setTimeout(()=>{ try{ map.invalidateSize(); }catch(_){} },150); }
function shouldAutoCollapse(){ return window.innerWidth<=900; }
function applySidebarCollapsed(on){ if(on) document.body.classList.add('sidebar-collapsed'); else document.body.classList.remove('sidebar-collapsed'); invalidateMap(); }
(function(){ let saved=localStorage.getItem(SIDEBAR_KEY); let coll=saved==='1'; if(shouldAutoCollapse()) coll=true; applySidebarCollapsed(coll); })();
toggleSidebarBtn.addEventListener('click',()=>{ const isColl=document.body.classList.contains('sidebar-collapsed'); localStorage.setItem(SIDEBAR_KEY, isColl?'0':'1'); applySidebarCollapsed(!isColl); });
window.addEventListener('resize',()=>{ if(shouldAutoCollapse()) applySidebarCollapsed(true); invalidateMap(); });

// ===== Debounce =====
const SOFT_MS=150, HARD_MS=300; let DEBOUNCE_MS=SOFT_MS; let _lastTs=0; function debounceEvent(){ const now=Date.now(); if(now-_lastTs<DEBOUNCE_MS) return true; _lastTs=now; return false; }
document.getElementById('hard-debounce').addEventListener('change',e=>{ DEBOUNCE_MS = e.target.checked?HARD_MS:SOFT_MS; });

// ===== Floating search (C2-A) =====
const floatingSearchBtn=document.getElementById('floating-search-btn');
const searchOverlay=document.getElementById('search-overlay');
const searchClose=document.getElementById('search-close');
const searchBtn=document.getElementById('search-btn');
const placeInput=document.getElementById('place-input');
floatingSearchBtn.addEventListener('click',()=>{ searchOverlay.classList.add('active'); searchOverlay.setAttribute('aria-hidden','false'); placeInput.focus(); });
searchClose.addEventListener('click',()=>{ searchOverlay.classList.remove('active'); searchOverlay.setAttribute('aria-hidden','true'); });
placeInput.addEventListener('keydown',e=>{ if(e.key==='Enter') searchPlaceNL(); });
searchBtn.addEventListener('click', searchPlaceNL);

async function geocodePhoton(q){ const url=`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`; const r=await fetch(url,{headers:{'Accept':'application/json'}}); if(!r.ok) throw new Error('Photon fout'); const j=await r.json(); const f=j?.features?.[0]; if(!f) throw new Error('Geen resultaat'); return {lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0], provider:'photon'}; }
async function geocodeMapsCo(q,key){ const url=`https://geocode.maps.co/search?q=${encodeURIComponent(q)}${key?`&api_key=${encodeURIComponent(key)}`:''}`; const r=await fetch(url,{headers:{'Accept':'application/json'}}); if(!r.ok) throw new Error('maps.co fout'); const j=await r.json(); if(!Array.isArray(j)||j.length===0) throw new Error('Geen resultaat'); const b=j[0]; return {lat:parseFloat(b.lat), lon:parseFloat(b.lon), provider:'maps.co'}; }
async function searchPlaceNL(){ const q=placeInput.value?.trim(); if(!q) return; setStatus(statusGeo, 'Geocoder: zoeken…', 'warn'); const geocoder=document.getElementById('geocoder-select').value; const key=document.getElementById('mapsco-key').value.trim(); try{ let res; if(geocoder==='photon'){ res=await geocodePhoton(q);} else if(geocoder==='mapsco'){ res=await geocodeMapsCo(q,key);} else { try{ res=await geocodePhoton(q);} catch(e){ res=await geocodeMapsCo(q,key);} } map.setView([res.lat,res.lon], 13); setStatus(statusGeo, `Geocoder: ${res.provider} OK`, 'ok'); searchOverlay.classList.remove('active'); searchOverlay.setAttribute('aria-hidden','true'); }catch(e){ alert('Zoeken mislukt of geen resultaat.'); setStatus(statusGeo,'Geocoder: fout','err'); } }

// ===== Icons & groups =====
const markersGroup=L.featureGroup().addTo(map);
const linesGroup=L.featureGroup().addTo(map);
const circlesGroup=L.featureGroup().addTo(map);
const handlesGroup=L.featureGroup().addTo(map);

let allMarkers=[]; let allLines=[]; let allSectors=[];
function makeDivIcon(html,bg='#1e293b',border='#334155'){ return L.divIcon({className:'custom-div-icon', html:`<div style="background:${bg};color:#fff;border:2px solid ${border};border-radius:12px;padding:4px 6px;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.3);">${html}</div>`, iconSize:[32,22], iconAnchor:[16,11]}); }
const ICONS={ hoornaar:(a)=>makeDivIcon(`🐝${a?` x${a}`:''}`,'#933','#b55'), nest:()=>makeDivIcon('🪹','#445','#667'), nest_geruimd:()=>makeDivIcon('✅','#264','#396'), lokpot:()=>makeDivIcon('🪤','#274','#396'), pending:()=>makeDivIcon('➕','#333','#555') };

let contextMenuEl=null; function closeContextMenu(){ if(contextMenuEl){ contextMenuEl.remove(); contextMenuEl=null; document.removeEventListener('keydown', escClose); document.removeEventListener('click', closeContextMenuOnce, true); } }
function positionMenu(el,x,y){ const pad=6,vw=window.innerWidth,vh=window.innerHeight; el.style.left=Math.min(vw-el.offsetWidth-pad,Math.max(pad,x))+'px'; el.style.top=Math.min(vh-el.offsetHeight-pad,Math.max(pad,y))+'px'; }
function escClose(e){ if(e.key==='Escape') closeContextMenu(); }
function closeContextMenuOnce(){ closeContextMenu(); }

function openMapContextMenu(latlng, x, y){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Nieuw icoon</h4>
<button data-act="mk" data-type="hoornaar">🐝 Waarneming</button>
<button data-act="mk" data-type="nest">🪹 Nest</button>
<button data-act="mk" data-type="nest_geruimd">✅ Nest geruimd</button>
<button data-act="mk" data-type="lokpot">🪤 Lokpot</button>`;
  el.addEventListener('click',ev=>{ const b=ev.target.closest('button'); if(!b) return; closeContextMenu(); openPropModal({ type:b.dataset.type, onSave:(vals)=>{ createMarkerWithPropsAt(latlng, b.dataset.type, vals); } }); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}

function openMarkerContextMenu(marker, x, y){ closeContextMenu(); const isLokpot=(marker._meta||{}).type==='lokpot'; const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Icoon</h4>
<button data-act="edit">✏️ Eigenschappen</button>
${isLokpot?'<button data-act="new_line">📐 Zichtlijn toevoegen</button>':''}
<button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',ev=>{ const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act; closeContextMenu(); setTimeout(()=>{ if(act==='edit'){ openPropModal({ type: marker._meta.type, init: marker._meta, onSave:(vals)=>{ applyPropsToMarker(marker, vals); } }); } else if(act==='new_line'){ startSightLine(marker); } else if(act==='delete'){ deleteMarkerAndAssociations(marker); } },0); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}

function openLineContextMenu(line, x, y){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Zichtlijn</h4>
<button data-act="color">🎨 Kleur bewerken</button>
<button data-act="delete">🗑️ Verwijderen</button>`;
  el.addEventListener('click',ev=>{ const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act; closeContextMenu(); setTimeout(()=>{ if(act==='delete'){ deleteSightLine(line); } else if(act==='color'){ openLineColorPicker(line, x, y); } },0); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}

function openLineColorPicker(line, x, y){ closeContextMenu(); const curr=line._meta?.color||'#ffcc00'; const el=document.createElement('div'); el.className='ctx-menu'; el.innerHTML=`<h4>Lijnkleur</h4>
<input id="lc_hex" type="color" value="${curr}" style="width:100%;height:36px;border:0;background:transparent" />
<div class="actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
  <button data-act="cancel" class="btn-secondary">Annuleren</button>
  <button data-act="save" class="btn-primary">Opslaan</button>
</div>`;
  el.addEventListener('click',ev=>{ const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act; if(act==='cancel'){ closeContextMenu(); return; } if(act==='save'){ const color=el.querySelector('#lc_hex').value; setSightLineColor(line,color); closeContextMenu(); } });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el,x,y); document.addEventListener('keydown',escClose); document.addEventListener('click',closeContextMenuOnce,true);
}

// ===== Properties modal =====
const modalEl = document.getElementById('prop-modal');
const pmDate = document.getElementById('pm-date');
const pmBy = document.getElementById('pm-by');
const pmAmount = document.getElementById('pm-amount');
const pmSave = document.getElementById('pm-save');
const pmCancel = document.getElementById('pm-cancel');

function openPropModal({type, init={}, onSave}){
  pmDate.value = init.date || new Date().toISOString().slice(0,10);
  pmBy.value = init.by || '';
  if(type==='hoornaar'){
    document.querySelector('.only-hoornaar').style.display='grid';
    pmAmount.value = (init.aantal!=null? init.aantal : '');
  } else {
    document.querySelector('.only-hoornaar').style.display='none';
  }
  modalEl.classList.remove('hidden');
  const onCancel=()=>{ cleanup(); };
  const onOk=()=>{ const vals={ date: pmDate.value, by: pmBy.value };
    if(type==='hoornaar'){ const a=parseInt(pmAmount.value,10); if(!isNaN(a)) vals.aantal=a; }
    onSave && onSave(vals); cleanup(); };
  pmCancel.onclick=onCancel; pmSave.onclick=onOk;
  function cleanup(){ pmCancel.onclick=null; pmSave.onclick=null; modalEl.classList.add('hidden'); }
}

function applyPropsToMarker(marker, vals){ const m=marker._meta||{}; if(vals.date) m.date=vals.date; else delete m.date; if(vals.by) m.by=vals.by; else delete m.by; if(m.type==='hoornaar'){ if(vals.aantal!=null) m.aantal=vals.aantal; else delete m.aantal; marker.setIcon(ICONS.hoornaar(m.aantal)); } else if(m.type==='nest'){ marker.setIcon(ICONS.nest()); } else if(m.type==='nest_geruimd'){ marker.setIcon(ICONS.nest_geruimd()); } else if(m.type==='lokpot'){ marker.setIcon(ICONS.lokpot()); }
  marker._meta=m; attachMarkerPopup(marker); }

function createMarkerWithPropsAt(latlng, type, vals){ const marker = placeMarkerAt(latlng, type); applyPropsToMarker(marker, vals); return marker; }

function placeMarkerAt(latlng, type='pending'){ let marker; if(type==='hoornaar'){ marker=L.marker(latlng,{icon:ICONS.hoornaar()}); marker._meta={type}; } else if(type==='nest'){ marker=L.marker(latlng,{icon:ICONS.nest()}); marker._meta={type}; } else if(type==='nest_geruimd'){ marker=L.marker(latlng,{icon:ICONS.nest_geruimd()}); marker._meta={type}; } else if(type==='lokpot'){ marker=L.marker(latlng,{icon:ICONS.lokpot()}); marker._meta={type,id:`pot_${Date.now()}_${Math.random().toString(36).slice(2)}`}; } else { marker=L.marker(latlng,{icon:ICONS.pending()}); marker._meta={type:'pending'}; }
  marker.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(debounceEvent()) return; openMarkerContextMenu(marker, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
  allMarkers.push(marker); markersGroup.addLayer(marker); attachMarkerPopup(marker); return marker; }

function deleteMarkerAndAssociations(marker){ const meta=marker._meta||{}; if(meta.type==='lokpot' && meta.id){ removePotAssociations(meta.id); }
  markersGroup.removeLayer(marker); allMarkers = allMarkers.filter(m=>m!==marker); }

function attachMarkerPopup(marker){ const m=marker._meta||{}; let txt=''; if(m.type==='hoornaar'){ txt+= m.aantal?`Waarneming (x${m.aantal})`:'Waarneming'; } else if(m.type==='nest'){ txt+='Nest'; } else if(m.type==='nest_geruimd'){ txt+='Nest geruimd'; } else if(m.type==='lokpot'){ txt='Lokpot'; } else { txt='Nieuw icoon'; } if(m.date) txt+=`<br>Datum: ${m.date}`; if(m.by) txt+=`<br>Door: ${m.by}`; marker.bindPopup(txt); }

let drawing=false; map.on('pm:drawstart',()=>drawing=true); map.on('pm:drawend',()=>drawing=false);
map.on('click',e=>{ if(debounceEvent()) return; if(drawing) return; openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });
map.on('contextmenu',e=>{ if(debounceEvent()) return; if(drawing) return; openMapContextMenu(e.latlng, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); });

const R_EARTH=6371000; function toRad(d){return d*Math.PI/180} function toDeg(r){return r*180/Math.PI}
function bearingBetween(a,b){const phi1=toRad(a.lat),phi2=toRad(b.lat);const dlam=toRad(b.lng-a.lng);const y=Math.sin(dlam)*Math.cos(phi2);const x=Math.cos(phi1)*Math.sin(phi2)-Math.sin(phi1)*Math.cos(phi2)*Math.cos(dlam);const theta=Math.atan2(y,x);return (toDeg(theta)+360)%360}
function destinationPoint(start,distance,bearingDeg){const delta=distance/R_EARTH;const theta=toRad(bearingDeg);const phi1=toRad(start.lat);const lam1=toRad(start.lng);const sinphi1=Math.sin(phi1),cosphi1=Math.cos(phi1);const sind=Math.sin(delta),cosd=Math.cos(delta);const sinphi2=sinphi1*cosd + cosphi1*sind*Math.cos(theta);const phi2=Math.asin(sinphi2);const y=Math.sin(theta)*sind*cosphi1;const x=cosd - sinphi1*sinphi2;const lam2=lam1+Math.atan2(y,x);return L.latLng(toDeg(phi2),((toDeg(lam2)+540)%360)-180)}
function arcPoints(center,radius,startDeg,endDeg,steps=32){const pts=[],total=endDeg-startDeg,step=total/steps;for(let i=0;i<=steps;i++){const brg=startDeg+step*i;pts.push(destinationPoint(center,radius,brg))}return pts}

function registerLine(line){ if(!allLines.includes(line)) allLines.push(line); }
function unregisterLine(line){ allLines = allLines.filter(l=>l!==line); }
function registerSector(sector){ if(!allSectors.includes(sector)) allSectors.push(sector); }
function unregisterSector(sector){ allSectors = allSectors.filter(s=>s!==sector); }

function createSectorLayer({pot,distance,color='#ffcc00',bearing,rInner,rOuter,angleLeft=45,angleRight=45,steps=36,flightId}){const center=L.latLng(pot.lat,pot.lng);const start=bearing-angleLeft;const end=bearing+angleRight;const outer=arcPoints(center,rOuter,start,end,steps);const inner=arcPoints(center,rInner,end,start,steps);const ring=[...outer,...inner];const poly=L.polygon(ring,{color,weight:1,dashArray:'6 6',fillColor:color,fillOpacity:0.25});poly._meta={type:'sector',pot,distance,color,bearing,rInner,rOuter,angleLeft,angleRight,steps,flightId};return poly}
function makeHandleIcon(){return L.divIcon({className:'line-handle',html:'<div></div>',iconSize:[12,12],iconAnchor:[6,6]})}

function setSightLineColor(line,color){ line.setStyle({color}); line._meta=line._meta||{}; line._meta.color=color; if(line._sector){ line._sector.setStyle({color, fillColor:color}); line._sector._meta.color=color; } }

function deleteSightLine(line){ if(line._handle){ handlesGroup.removeLayer(line._handle); line._handle=null; } if(line._sector){ circlesGroup.removeLayer(line._sector); unregisterSector(line._sector); line._sector=null; } if(line.getTooltip()) line.unbindTooltip(); linesGroup.removeLayer(line); unregisterLine(line); }

function startSightLine(lokpotMarker){ const potLatLng=lokpotMarker.getLatLng(); let dist = prompt('Afstand tot nest (meter):','200'); if(dist===null) return; dist=Math.max(1, parseInt(dist,10) || 1); const defaultColor = '#'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0'); const tempGuide=L.polyline([potLatLng,potLatLng],{color:defaultColor,weight:2,dashArray:'4 4'}).addTo(map); const onMove=(e)=>{ tempGuide.setLatLngs([potLatLng,e.latlng]); }; const onClick=(e)=>{ map.off('mousemove', onMove); map.off('click', onClick); tempGuide.remove(); const clicked=e.latlng; const bearing=bearingBetween(potLatLng, clicked); const endLatLng=destinationPoint(potLatLng, dist, bearing); const flightId=`flight_${Date.now()}_${Math.random().toString(36).slice(2)}`; const line=L.polyline([potLatLng, endLatLng],{color:defaultColor,weight:3}).addTo(linesGroup); line._meta={type:'flight',pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:(lokpotMarker._meta||{}).id},potId:(lokpotMarker._meta||{}).id,distance:dist,color:defaultColor,bearing,flightId}; registerLine(line); line.bindTooltip(`${dist} m`,{permanent:true,direction:'center',className:'line-label'}); const rInner=Math.max(1,dist-25), rOuter=dist+25; const sector=createSectorLayer({pot:{lat:potLatLng.lat,lng:potLatLng.lng,id:(lokpotMarker._meta||{}).id},distance:dist,color:defaultColor,bearing,rInner,rOuter,angleLeft:45,angleRight:45,steps:36,flightId}).addTo(circlesGroup); registerSector(sector); line._sector=sector; sector._line=line; attachSightLineInteractivity(line); }; map.on('mousemove', onMove); map.on('click', onClick); }

function attachSightLineInteractivity(line){ const meta=line._meta||{}; if(meta.type!=='flight') return; const pot=L.latLng(meta.pot.lat,meta.pot.lng); const end=line.getLatLngs()[1]; line.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(debounceEvent()) return; openLineContextMenu(line, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); }); if(line._handle){ handlesGroup.removeLayer(line._handle); line._handle=null; } const handle=L.marker(end,{icon:makeHandleIcon(),draggable:true,zIndexOffset:1500}).addTo(handlesGroup); line._handle=handle; handle.on('contextmenu',e=>{ e.originalEvent?.preventDefault(); e.originalEvent?.stopPropagation(); if(debounceEvent()) return; openLineContextMenu(line, e.originalEvent?.clientX||0, e.originalEvent?.clientY||0); }); handle.on('drag',()=>{ const raw=handle.getLatLng(); const brg=bearingBetween(pot,raw); const dist=Math.max(1,Math.round(pot.distanceTo(raw))); const constrained=destinationPoint(pot,dist,brg); handle.setLatLng(constrained); line.setLatLngs([pot,constrained]); line._meta.bearing=brg; line._meta.distance=dist; if(line.getTooltip()) line.setTooltipContent(`${dist} m`); if(line._sector){ circlesGroup.removeLayer(line._sector); unregisterSector(line._sector); line._sector=null; } const rInner=Math.max(1,dist-25), rOuter=dist+25; const sector=createSectorLayer({pot:meta.pot,distance:dist,color:meta.color,bearing:brg,rInner,rOuter,angleLeft:45,angleRight:45,steps:36,flightId:meta.flightId}).addTo(circlesGroup); registerSector(sector); line._sector=sector; sector._line=line; }); }

function removePotAssociations(potId){ const toRemoveLines=[]; allLines.forEach(l=>{ const m=l._meta||{}; if(m.potId===potId) toRemoveLines.push(l); }); toRemoveLines.forEach(deleteSightLine); const toRemoveSectors=[]; allSectors.forEach(c=>{ const m=c._meta||{}; if(m.type==='sector'&&(m.pot?.id===potId||m.potId===potId)) toRemoveSectors.push(c); }); toRemoveSectors.forEach(c=>{ circlesGroup.removeLayer(c); unregisterSector(c); }); }

function getActiveFilters(){ return { hoornaar: !!document.getElementById('f_type_hoornaar').checked, nest: !!document.getElementById('f_type_nest').checked, nest_geruimd: !!document.getElementById('f_type_nest_geruimd').checked, lokpot: !!document.getElementById('f_type_lokpot').checked, pending: !!document.getElementById('f_type_pending').checked, dateBefore: document.getElementById('f_date_before').value || '' }; }
function applyFilters(){ const f=getActiveFilters(); allMarkers.forEach(m=>{ const meta=m._meta||{}; let show=!!f[meta.type]; if(f.dateBefore && meta.date){ if(meta.date < f.dateBefore) show=false; } if(show) markersGroup.addLayer(m); else markersGroup.removeLayer(m); }); const visiblePotIds=new Set(); allMarkers.forEach(m=>{ const meta=m._meta||{}; if(meta.type==='lokpot' && markersGroup.hasLayer(m)) visiblePotIds.add(meta.id); }); allLines.forEach(line=>{ const meta=line._meta||{}; const should = visiblePotIds.has(meta.potId); const onMap = linesGroup.hasLayer(line); if(should && !onMap) linesGroup.addLayer(line); if(!should && onMap) linesGroup.removeLayer(line); if(line._handle){ const showH = should; const inH = handlesGroup.hasLayer(line._handle); if(showH && !inH) handlesGroup.addLayer(line._handle); if(!showH && inH) handlesGroup.removeLayer(line._handle); } if(line._sector){ const showS = should; const inS = circlesGroup.hasLayer(line._sector); if(showS && !inS) circlesGroup.addLayer(line._sector); if(!showS && inS) circlesGroup.removeLayer(line._sector); } }); }

document.getElementById('apply-filters').addEventListener('click', applyFilters);
document.getElementById('reset-filters').addEventListener('click', ()=>{ document.getElementById('f_type_hoornaar').checked=true; document.getElementById('f_type_nest').checked=true; document.getElementById('f_type_nest_geruimd').checked=true; document.getElementById('f_type_lokpot').checked=true; document.getElementById('f_type_pending').checked=true; document.getElementById('f_date_before').value=''; applyFilters(); });

const polygonsGroup=L.featureGroup().addTo(map);
map.on('pm:create', (e)=>{ const layer=e.layer; if(e.shape==='Polygon' || e.shape==='Rectangle'){ polygonsGroup.addLayer(layer); initPolygon(layer); } else { layer.remove(); } });

function initPolygon(layer){ layer._props = layer._props || { label:'', color:'#0aa879' }; const col = layer._props.color||'#0aa879'; layer.setStyle({ color: col, fillColor: col, fillOpacity: .2, weight: 2 }); refreshPolygonLabel(layer); const open = (ev)=>{ ev.originalEvent?.preventDefault(); ev.originalEvent?.stopPropagation(); if(debounceEvent()) return; openUnifiedContextMenu({ x:ev.originalEvent?.clientX||0, y:ev.originalEvent?.clientY||0, latlng:ev.latlng, polygonLayer: layer }); }; layer.on('contextmenu', open); layer.on('click', open); }

function polygonCentroid(layer){ try{ const latlngs = layer.getLatLngs(); const ring = Array.isArray(latlngs[0])? (Array.isArray(latlngs[0][0])?latlngs[0][0]:latlngs[0]) : latlngs; if(!ring || ring.length<3) return layer.getBounds().getCenter(); let area=0, cx=0, cy=0; for(let i=0,j=ring.length-1;i<ring.length;j=i++){ const x0=ring[j].lng, y0=ring[j].lat, x1=ring[i].lng, y1=ring[i].lat; const f=x0*y1 - x1*y0; area+=f; cx+=(x0+x1)*f; cy+=(y0+y1)*f; } area*=0.5; if(Math.abs(area)<1e-12) return layer.getBounds().getCenter(); cx/=(6*area); cy/=(6*area); return L.latLng(cy,cx); }catch{ return layer.getBounds().getCenter(); } }

function refreshPolygonLabel(layer){ const lbl=layer._props?.label||''; const col=layer._props?.color||'#0aa879'; if(lbl){ const pos = polygonCentroid(layer); if(!layer._labelTooltip){ layer._labelTooltip = L.tooltip({permanent:true, direction:'center', className:'poly-label'}).setContent(lbl).setLatLng(pos); layer._labelTooltip.addTo(map); } else { layer._labelTooltip.setContent(lbl).setLatLng(pos); } const el = layer._labelTooltip.getElement(); if(el){ el.style.borderColor = col; } } else { if(layer._labelTooltip){ map.removeLayer(layer._labelTooltip); layer._labelTooltip=null; } } }

function openUnifiedContextMenu(opts){ closeContextMenu(); const el=document.createElement('div'); el.className='ctx-menu'; let html=''; if(opts.polygonLayer){ html += `<h4>Polygoon</h4>
<button data-act="poly_label">✏️ Label wijzigen</button>
<button data-act="poly_color">🎨 Kleur wijzigen</button>
<button data-act="poly_edit">✍️ Vorm bewerken aan/uit</button>
<button data-act="poly_delete">🗑️ Verwijderen</button>
<hr/>`; }
  html += `<h4>Nieuw icoon</h4>
<button data-act="mk" data-type="hoornaar">🐝 Waarneming</button>
<button data-act="mk" data-type="nest">🪹 Nest</button>
<button data-act="mk" data-type="nest_geruimd">✅ Nest geruimd</button>
<button data-act="mk" data-type="lokpot">🪤 Lokpot</button>`; el.innerHTML = html;
  el.addEventListener('click', ev=>{ const b=ev.target.closest('button'); if(!b) return; const act=b.dataset.act; closeContextMenu(); setTimeout(()=>{ if(act==='mk'){ createMarkerWithPropsAt(opts.latlng, b.dataset.type, {date:new Date().toISOString().slice(0,10)}); return; } if(!opts.polygonLayer) return; if(act==='poly_label'){ const lbl=prompt('Polygoon label:', opts.polygonLayer._props?.label||''); if(lbl===null) return; opts.polygonLayer._props = opts.polygonLayer._props||{}; opts.polygonLayer._props.label = lbl; refreshPolygonLabel(opts.polygonLayer); } else if(act==='poly_color'){ const col=prompt('Kleur (CSS/hex, bv. #ffcc00):', opts.polygonLayer._props?.color||'#0aa879'); if(col===null) return; opts.polygonLayer._props = opts.polygonLayer._props||{}; opts.polygonLayer._props.color = col; opts.polygonLayer.setStyle({ color: col, fillColor: col }); refreshPolygonLabel(opts.polygonLayer); } else if(act==='poly_edit'){ const enabled = opts.polygonLayer.pm?.enabled(); if(enabled) opts.polygonLayer.pm.disable(); else opts.polygonLayer.pm.enable(); } else if(act==='poly_delete'){ polygonsGroup.removeLayer(opts.polygonLayer); } },0); });
  document.body.appendChild(el); contextMenuEl=el; positionMenu(el, opts.x||0, opts.y||0); document.addEventListener('keydown', escClose); document.addEventListener('click', closeContextMenuOnce, true);
}

function exportData(){ const data={ markers: allMarkers.map(m=>({ latlng:m.getLatLng(), meta:m._meta })), sightlines: allLines.map(l=>({ latlngs:l.getLatLngs(), meta:l._meta })), polygons: polygonsGroup.getLayers().map(p=>({ latlngs:p.getLatLngs(), props:p._props })) }; const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='hornet-data.json'; a.click(); }
document.getElementById('export-btn').addEventListener('click', exportData);
document.getElementById('import-file').addEventListener('change', e=>{ const f=e.target.files?.[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ try{ const d=JSON.parse(r.result); (d.markers||[]).forEach(item=>{ const m=placeMarkerAt(item.latlng, item.meta.type); m._meta=item.meta; attachMarkerPopup(m); }); (d.sightlines||[]).forEach(s=>{ const line=L.polyline(s.latlngs,{color:(s.meta?.color||'#ffcc00'),weight:3}).addTo(linesGroup); line._meta=s.meta; registerLine(line); if(line._meta?.distance){ line.bindTooltip(`${line._meta.distance} m`,{permanent:true,direction:'center',className:'line-label'}); } attachSightLineInteractivity(line); if(line._meta){ const pot=line._meta.pot; const dist=line._meta.distance||100; const brg=line._meta.bearing||0; const rInner=Math.max(1,dist-25), rOuter=dist+25; const sector=createSectorLayer({pot, distance:dist, color:line._meta.color||'#ffcc00', bearing:brg, rInner, rOuter, angleLeft:45, angleRight:45, steps:36, flightId:line._meta.flightId||''}).addTo(circlesGroup); registerSector(sector); line._sector=sector; sector._line=line; } }); (d.polygons||[]).forEach(pg=>{ const layer=L.polygon(pg.latlngs).addTo(polygonsGroup); layer._props=pg.props||{label:'',color:'#0aa879'}; initPolygon(layer); }); applyFilters(); }catch{ alert('Import mislukt'); } }; r.readAsText(f); });

document.getElementById('btn-selftest').addEventListener('click', async()=>{ try{ await geocodePhoton('Utrecht'); setStatus(statusGeo,'Photon OK','ok'); }catch{ setStatus(statusGeo,'Photon NOK','err'); } const key=document.getElementById('mapsco-key').value.trim(); try{ await geocodeMapsCo('Utrecht',key); setStatus(statusGeo,'Maps.co OK','ok'); }catch{ setStatus(statusGeo,'Maps.co NOK','err'); } });

const ENABLE_FIRESTORE=false; function initFirestoreIfEnabled(){ if(!ENABLE_FIRESTORE) return; /*
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
  import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
  const firebaseConfig = { };
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
*/ }
initFirestoreIfEnabled();
