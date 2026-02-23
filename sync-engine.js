// sync-engine.js — Hornet Mapper NL v6.1.0 (Hybrid realtime sync)
// ---------------------------------------------------------------
// Vereist: firebase.js
// ---------------------------------------------------------------

import {
  db
} from "./firebase.js";

import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";


// ---------------------------------------------------------------
// Configuratie — dynamische scope (jaar + groep)
// ---------------------------------------------------------------
import { collection, doc, setDoc, deleteDoc, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

export let ACTIVE_YEAR  = "2026";
export let ACTIVE_GROUP = "Hoornaar_Zeist";

let colMarkers, colLines, colSectors, colPolys;

export function setActiveScope(year, group) {
  ACTIVE_YEAR  = year;
  ACTIVE_GROUP = group;
  const base = `maps/${ACTIVE_YEAR}/${ACTIVE_GROUP}`;
  colMarkers = collection(db, `${base}/markers`);
  colLines   = collection(db, `${base}/lines`);
  colSectors = collection(db, `${base}/sectors`);
  colPolys   = collection(db, `${base}/polygons`);
  return { year: ACTIVE_YEAR, group: ACTIVE_GROUP, base };
}

// eerste init (default)
setActiveScope(ACTIVE_YEAR, ACTIVE_GROUP);


// ---------------------------------------------------------------
// Offline write queue
// ---------------------------------------------------------------
let writeQueue = [];
let online = true;

window.addEventListener("online",  () => { online = true;  flushQueue(); });
window.addEventListener("offline", () => { online = false; });

async function flushQueue() {
  if (!online) return;
  const queue = [...writeQueue];
  writeQueue = [];
  for (let job of queue) {
    try {
      if (job.type === "set") await setDoc(job.ref, job.data);
      if (job.type === "del") await deleteDoc(job.ref);
    } catch (err) {
      console.warn("Kon Firestore write niet uitvoeren, opnieuw in queue:", err);
      writeQueue.push(job);
    }
  }
}

// Helper voor veilige writes
async function safeSetDoc(ref, data) {
  if (online) {
    try { return await setDoc(ref, data); }
    catch (e) {
      console.warn("SetDoc fout — toegevoegd aan queue:", e);
      writeQueue.push({ type: "set", ref, data });
    }
  } else {
    writeQueue.push({ type: "set", ref, data });
  }
}

// Helper voor deletes
async function safeDeleteDoc(ref) {
  if (online) {
    try { return await deleteDoc(ref); }
    catch (e) {
      console.warn("DeleteDoc fout — queue:", e);
      writeQueue.push({ type: "del", ref });
    }
  } else {
    writeQueue.push({ type: "del", ref });
  }
}

// ---------------------------------------------------------------
//  WRITES — worden door app.js gebruikt
// ---------------------------------------------------------------

// Marker opslaan of updaten
export function saveMarkerToCloud(markerObj) {
  markerObj.updatedAt = serverTimestamp();
  const ref = doc(colMarkers, markerObj.id);
  return safeSetDoc(ref, markerObj);
}

// Marker verwijderen
export function deleteMarkerFromCloud(markerId) {
  return safeDeleteDoc(doc(colMarkers, markerId));
}

// Line opslaan
export function saveLineToCloud(lineObj) {
  lineObj.updatedAt = serverTimestamp();
  const ref = doc(colLines, lineObj.id);
  return safeSetDoc(ref, lineObj);
}

// Line verwijderen
export function deleteLineFromCloud(lineId) {
  return safeDeleteDoc(doc(colLines, lineId));
}

// Sector opslaan
export function saveSectorToCloud(sectorObj) {
  sectorObj.updatedAt = serverTimestamp();
  const ref = doc(colSectors, sectorObj.id);
  return safeSetDoc(ref, sectorObj);
}

// Sector verwijderen
export function deleteSectorFromCloud(sectorId) {
  return safeDeleteDoc(doc(colSectors, sectorId));
}

// Polygon opslaan (met shape)
export function savePolygonToCloud(polyObj) {
  polyObj.updatedAt = serverTimestamp();
  const ref = doc(colPolys, polyObj.id);
  return safeSetDoc(ref, polyObj);
}

// Polygon verwijderen
export function deletePolygonFromCloud(polyId) {
  return safeDeleteDoc(doc(colPolys, polyId));
}

// ---------------------------------------------------------------
//  READ / LISTENERS — pushen realtime updates naar app.js
// ---------------------------------------------------------------
export function listenToCloudChanges(callbacks) {

  // -------- MARKERS --------
  onSnapshot(colMarkers, (snap) => {
    snap.docChanges().forEach((ch) => {
      const data = ch.doc.data();
      if (!data) return;
      if (ch.type === "added" || ch.type === "modified") {
        callbacks.onMarkerUpdate && callbacks.onMarkerUpdate(data);
      }
      if (ch.type === "removed") {
        callbacks.onMarkerDelete && callbacks.onMarkerDelete(data.id);
      }
    });
  });

  // -------- LINES --------
  onSnapshot(colLines, (snap) => {
    snap.docChanges().forEach((ch) => {
      const data = ch.doc.data();
      if (!data) return;
      if (ch.type === "added" || ch.type === "modified") {
        callbacks.onLineUpdate && callbacks.onLineUpdate(data);
      }
      if (ch.type === "removed") {
        callbacks.onLineDelete && callbacks.onLineDelete(data.id);
      }
    });
  });

  // -------- SECTORS --------
  onSnapshot(colSectors, (snap) => {
    snap.docChanges().forEach((ch) => {
      const data = ch.doc.data();
      if (!data) return;
      if (ch.type === "added" || ch.type === "modified") {
        callbacks.onSectorUpdate && callbacks.onSectorUpdate(data);
      }
      if (ch.type === "removed") {
        callbacks.onSectorDelete && callbacks.onSectorDelete(data.id);
      }
    });
  });

  // -------- POLYGONS --------
  onSnapshot(colPolys, (snap) => {
    snap.docChanges().forEach((ch) => {
      const data = ch.doc.data();
      if (!data) return;
      if (ch.type === "added" || ch.type === "modified") {
        callbacks.onPolygonUpdate && callbacks.onPolygonUpdate(data);
      }
      if (ch.type === "removed") {
        callbacks.onPolygonDelete && callbacks.onPolygonDelete(data.id);
      }
    });
  });
}