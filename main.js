// HornetApp main entry
if (window.__hornetStarted) console.warn('startHornetApp: tweede start gedetecteerd – skip');
else window.__hornetStarted = true;

import './config.js';
import { auth } from './firebase.js';
import { openMapContextMenu } from './sync-engine.js';
import { getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.mjs';

getRedirectResult(auth).then(result => {
  if (result?.user) {
    console.log('Redirect login OK:', result.user);
    alert('Succesvol ingelogd!');
  }
}).catch(console.error);

window.addEventListener('DOMContentLoaded', () => { startHornetApp(); }, { once:true });

let map;
export function startHornetApp(){ initMap(); bindUi(); }

function initMap(){
  if(map && map.remove) map.remove();
  const el=document.getElementById('map');
  if(el && el._leaflet_id) el._leaflet_id=null;
  if(!window.L){ console.warn('Leaflet niet geladen'); return; }
  map=L.map('map',{center:[52.0907,5.1214],zoom:12});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  bindMapEvents(map);
}

function bindMapEvents(map){
  const handler=e=>{
    const x=e.originalEvent?.clientX ?? e.clientX ?? 0;
    const y=e.originalEvent?.clientY ?? e.clientY ?? 0;
    openMapContextMenu?.(e.latlng,x,y);
  };
  map.on('click',handler);
  map.on('contextmenu',handler);
}

function bindUi(){
  document.getElementById('loginBtn')?.addEventListener('click', onLogin);
  document.getElementById('addUserBtn')?.addEventListener('click', onAddUser);
}

async function onLogin(){
  try{
    const { loginWithGoogle } = await import('./firebase.js');
    await loginWithGoogle();
  }catch(err){ console.error(err); alert('Login mislukt: '+(err?.message||err)); }
}

async function onAddUser(){ alert('User toegevoegd (voorbeeld)'); }
