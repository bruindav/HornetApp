// sync-engine.js — Fix 38
// Firestore sync voor HornetApp
// Wijziging t.o.v. Fix 12: zoneId wordt nu automatisch meegegeven
// aan alle saveDoc-aanroepen, zodat Firestore rules canWriteZone() correct
// kunnen evalueren voor zowel admin als vrijwilligers.

import { app } from './firebase.js';
import {
  getFirestore,
  collection, doc,
  setDoc, deleteDoc,
  onSnapshot,
  query
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const db = getFirestore(app);

let _year  = String(new Date().getFullYear());
let _group = 'Hoornaar_Zeist';
let _base  = '';
let _unsubscribers = [];

// ======================= Scope =======================
// Zone alias: oude Hoornaar_ prefix → korte naam voor zoneId in documenten
const _ZONE_ALIAS = {
  'Hoornaar_Zeist':      'Zeist',
  'Hoornaar_Bilthoven':  'Bilthoven',
  'Hoornaar_Driebergen': 'Driebergen',
  'Hoornaar_Utrecht':    'Utrecht',
};
function _normalizeZone(z) { return _ZONE_ALIAS[z] || z; }

export function setActiveScope(year, group) {
  _year  = year;
  _group = _normalizeZone(group);   // zoneId altijd kort (Zeist, niet Hoornaar_Zeist)
  _base  = `maps/${year}/${group}/data`;  // Firestore pad ongewijzigd
  _unsubscribers.forEach(fn => { try { fn(); } catch {} });
  _unsubscribers = [];
  return { base: _base };
}

// Geeft de huidige actieve group/zone terug
export function getActiveGroup() {
  return _group;
}

// ======================= Realtime listeners =======================
export function listenToCloudChanges({
  onMarkerUpdate,  onMarkerDelete,
  onLineUpdate,    onLineDelete,
  onSectorUpdate,  onSectorDelete,
  onPolygonUpdate, onPolygonDelete
}) {
  _unsubscribers.forEach(fn => { try { fn(); } catch {} });
  _unsubscribers = [];

  function listen(colName, onUpdate, onDelete) {
    const colRef = collection(db, _base, colName);
    const unsub = onSnapshot(query(colRef), (snap) => {
      snap.docChanges().forEach(change => {
        const data = { id: change.doc.id, ...change.doc.data() };
        if (change.type === 'added' || change.type === 'modified') {
          onUpdate && onUpdate(data);
        } else if (change.type === 'removed') {
          onDelete && onDelete(change.doc.id);
        }
      });
    }, (err) => {
      console.warn(`[sync] listener fout op ${colName}:`, err.code, err.message);
    });
    _unsubscribers.push(unsub);
  }

  listen('markers',  onMarkerUpdate,  onMarkerDelete);
  listen('lines',    onLineUpdate,    onLineDelete);
  listen('sectors',  onSectorUpdate,  onSectorDelete);
  listen('polygons', onPolygonUpdate, onPolygonDelete);
}

// ======================= Schrijf helpers =======================
async function saveDoc(colName, id, data) {
  try {
    await setDoc(doc(db, _base, colName, id), data, { merge: true });
  } catch (err) {
    console.error(`[sync] saveDoc ${colName}/${id} mislukt:`, err.code, '—', err.message);
    throw err; // zodat aanroeper ook weet dat het mislukt is
  }
}

async function deleteDocument(colName, id) {
  try {
    await deleteDoc(doc(db, _base, colName, id));
  } catch (err) {
    console.error(`[sync] deleteDoc ${colName}/${id} mislukt:`, err.code, '—', err.message);
  }
}

// ======================= Markers =======================
export function saveMarkerToCloud(data) {
  return saveDoc('markers', data.id, { ...data, zoneId: data.zoneId || _group });
}
export function deleteMarkerFromCloud(id) { return deleteDocument('markers', id); }

// ======================= Lines =======================
export function saveLineToCloud(data) {
  return saveDoc('lines', data.id, { ...data, zoneId: data.zoneId || _group });
}
export function deleteLineFromCloud(id) { return deleteDocument('lines', id); }

// ======================= Sectors =======================
export function saveSectorToCloud(data) {
  return saveDoc('sectors', data.id, { ...data, zoneId: data.zoneId || _group });
}
export function deleteSectorFromCloud(id) { return deleteDocument('sectors', id); }

// ======================= Polygons =======================
export function savePolygonToCloud(data) {
  return saveDoc('polygons', data.id, { ...data, zoneId: data.zoneId || _group });
}
export function deletePolygonFromCloud(id) { return deleteDocument('polygons', id); }
