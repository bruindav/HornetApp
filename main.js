
// HornetApp main entry
// Anti-dubbelstart guard
if (window.__hornetStarted) {
  console.warn('startHornetApp: tweede start gedetecteerd – skip');
} else {
  window.__hornetStarted = true;
}

// Module imports (zorg dat bestandsnamen exact matchen)
import './config.js';
import './firebase.js';
import { openMapContextMenu } from './sync-engine.js';

window.addEventListener('DOMContentLoaded', () => {
  startHornetApp();
}, { once: true });

// Leaflet map referentie
let map;

export function startHornetApp() {
  // Idempotente init
  initMap();
  bindUi();
}

function initMap() {
  if (map && map.remove) {
    map.remove();
  }
  const el = document.getElementById('map');
  if (el && el._leaflet_id) el._leaflet_id = null;

  // LET OP: verwacht dat Leaflet L.global al geladen is. Pas aan naar jouw tiles.
  if (!window.L) {
    console.warn('Leaflet (L) niet gevonden – laad leaflet JS/CSS in index.html');
    return;
  }

  map = L.map('map', {
    center: [52.0907, 5.1214], // Utrecht als default
    zoom: 12,
  });

  // Voorbeeld tile (OpenStreetMap)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  bindMapEvents(map);
  return map;
}

function bindMapEvents(map) {
  const clickToMenu = (e) => {
    const x = e.originalEvent?.clientX ?? e.clientX ?? 0;
    const y = e.originalEvent?.clientY ?? e.clientY ?? 0;
    if (typeof openMapContextMenu === 'function') {
      openMapContextMenu(e.latlng, x, y);
    } else if (window.openMapContextMenu) {
      window.openMapContextMenu(e.latlng, x, y);
    } else {
      console.warn('openMapContextMenu is niet beschikbaar');
    }
  };

  map.on('click', clickToMenu);
  map.on('contextmenu', clickToMenu);
}

function bindUi() {
  document.getElementById('loginBtn')?.addEventListener('click', onLogin, { once: false });
  document.getElementById('addUserBtn')?.addEventListener('click', onAddUser, { once: false });
}

async function onLogin() {
  try {
    const { loginWithGoogle } = await import('./firebase.js');
    await loginWithGoogle();
    alert('Ingelogd');
  } catch (err) {
    console.error('Login error:', err);
    alert(`Login mislukt: ${err?.code || err?.message || err}`);
  }
}

async function onAddUser() {
  try {
    // Voorbeeld: hier zou je Firestore write kunnen doen
    alert('User toegevoegd (voorbeeld)');
  } catch (err) {
    console.error('addUser error:', err);
    alert(`User toevoegen mislukt: ${err?.code || err?.message || err}`);
  }
}
