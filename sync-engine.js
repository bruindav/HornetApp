// sync-engine.js — Fix 12
// Firestore sync voor HornetApp

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
export function setActiveScope(year, group) {
  _year  = year;
  _group = group;
  _base  = `maps/${year}/${group}/data`;
  _unsubscribers.forEach(fn => { try { fn(); } catch {} });
  _unsubscribers = [];
  return { base: _base };
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
export function saveMarkerToCloud(data)   { return saveDoc('markers', data.id, data); }
export function deleteMarkerFromCloud(id) { return deleteDocument('markers', id); }

// ======================= Lines =======================
export function saveLineToCloud(data)   { return saveDoc('lines', data.id, data); }
export function deleteLineFromCloud(id) { return deleteDocument('lines', id); }

// ======================= Sectors =======================
export function saveSectorToCloud(data)   { return saveDoc('sectors', data.id, data); }
export function deleteSectorFromCloud(id) { return deleteDocument('sectors', id); }

// ======================= Polygons =======================
export function savePolygonToCloud(data)   { return saveDoc('polygons', data.id, data); }
export function deletePolygonFromCloud(id) { return deleteDocument('polygons', id); }
