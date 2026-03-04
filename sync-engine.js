// sync-engine.js — Fix 7 — Firestore sync voor HornetApp
// Verzorgt alle lees/schrijf/luister operaties naar Firestore
// Pad structuur: /maps/{year}/{group}/data/{collection}/{docId}

import { app } from './firebase.js';
import {
  getFirestore,
  collection, doc,
  setDoc, deleteDoc,
  onSnapshot,
  query
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const db = getFirestore(app);

// Huidige scope
let _year = String(new Date().getFullYear());
let _group = 'Hoornaar_Zeist';
let _base = '';

// Actieve Firestore listeners (zodat we ze kunnen stoppen bij scope wissel)
let _unsubscribers = [];

// ======================= Scope =======================
export function setActiveScope(year, group) {
  _year = year;
  _group = group;
  _base = `maps/${year}/${group}/data`;
  // Stop bestaande listeners
  _unsubscribers.forEach(fn => { try { fn(); } catch {} });
  _unsubscribers = [];
  return { base: _base };
}

// ======================= Realtime listeners =======================
export function listenToCloudChanges({
  onMarkerUpdate, onMarkerDelete,
  onLineUpdate,   onLineDelete,
  onSectorUpdate, onSectorDelete,
  onPolygonUpdate, onPolygonDelete
}) {
  // Stop bestaande listeners eerst
  _unsubscribers.forEach(fn => { try { fn(); } catch {} });
  _unsubscribers = [];

  function listen(colName, onUpdate, onDelete) {
    const colRef = collection(db, _base, colName);
    const unsub = onSnapshot(query(colRef), (snap) => {
      snap.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          onUpdate && onUpdate({ id: change.doc.id, ...change.doc.data() });
        } else if (change.type === 'removed') {
          onDelete && onDelete(change.doc.id);
        }
      });
    }, (err) => {
      console.warn(`[sync] listener fout op ${colName}:`, err.message);
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
    const ref = doc(db, _base, colName, id);
    await setDoc(ref, data, { merge: true });
  } catch (err) {
    console.error(`[sync] saveDoc ${colName}/${id} mislukt:`, err.message);
  }
}

async function deleteDocument(colName, id) {
  try {
    const ref = doc(db, _base, colName, id);
    await deleteDoc(ref);
  } catch (err) {
    console.error(`[sync] deleteDoc ${colName}/${id} mislukt:`, err.message);
  }
}

// ======================= Markers =======================
export function saveMarkerToCloud(docData) {
  return saveDoc('markers', docData.id, docData);
}
export function deleteMarkerFromCloud(id) {
  return deleteDocument('markers', id);
}

// ======================= Lines =======================
export function saveLineToCloud(docData) {
  return saveDoc('lines', docData.id, docData);
}
export function deleteLineFromCloud(id) {
  return deleteDocument('lines', id);
}

// ======================= Sectors =======================
export function saveSectorToCloud(docData) {
  return saveDoc('sectors', docData.id, docData);
}
export function deleteSectorFromCloud(id) {
  return deleteDocument('sectors', id);
}

// ======================= Polygons =======================
export function savePolygonToCloud(docData) {
  return saveDoc('polygons', docData.id, docData);
}
export function deletePolygonFromCloud(id) {
  return deleteDocument('polygons', id);
}
