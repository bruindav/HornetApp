// sync-engine.js — Hornet Mapper NL v6.1.0 (hybride realtime sync)
// ---------------------------------------------------------------
// LET OP: Dit bestand mag slechts ÉÉN Firestore-import hebben!

import { db } from "./firebase.js";

import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

//
// -------------- DYNAMISCHE SCOPE (jaar + groep) ----------------
//

export let ACTIVE_YEAR  = "2026";
export let ACTIVE_GROUP = "Hoornaar_Zeist";

let colMarkers = null;
let colLines   = null;
let colSectors = null;
let colPolys   = null;

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

// Init default scope:
setActiveScope(ACTIVE_YEAR, ACTIVE_GROUP);

//
// ----------------------- OFFLINE QUEUE ------------------------
//

let writeQueue = [];
let online = navigator.onLine;

window.addEventListener("online", () => {
  online = true;
  flushQueue();
});
window.addEventListener("offline", () => {
  online = false;
});

async function flushQueue() {
  if (!online) return;
  const pending = [...writeQueue];
  writeQueue = [];

  for (const job of pending) {
    try {
      if (job.type === "set") {
        await setDoc(job.ref, job.data);
      } else {
        await deleteDoc(job.ref);
      }
    } catch (err) {
      console.warn("Firestore write mislukt, opnieuw in queue:", err);
      writeQueue.push(job);
    }
  }
}

function safeSet(ref, data) {
  if (online) {
    return setDoc(ref, data).catch(err => {
      console.warn("SetDoc fout → queue:", err);
      writeQueue.push({ type: "set", ref, data });
    });
  } else {
    writeQueue.push({ type: "set", ref, data });
  }
}

function safeDelete(ref) {
  if (online) {
    return deleteDoc(ref).catch(err => {
      console.warn("DeleteDoc fout → queue:", err);
      writeQueue.push({ type: "del", ref });
    });
  } else {
    writeQueue.push({ type: "del", ref });
  }
}

//
// ------------------- CLOUD WRITE API --------------------------
//

export function saveMarkerToCloud(obj) {
  obj.updatedAt = serverTimestamp();
  return safeSet(doc(colMarkers, obj.id), obj);
}

export function deleteMarkerFromCloud(id) {
  return safeDelete(doc(colMarkers, id));
}

export function saveLineToCloud(obj) {
  obj.updatedAt = serverTimestamp();
  return safeSet(doc(colLines, obj.id), obj);
}

export function deleteLineFromCloud(id) {
  return safeDelete(doc(colLines, id));
}

export function saveSectorToCloud(obj) {
  obj.updatedAt = serverTimestamp();
  return safeSet(doc(colSectors, obj.id), obj);
}

export function deleteSectorFromCloud(id) {
  return safeDelete(doc(colSectors, id));
}

export function savePolygonToCloud(obj) {
  obj.updatedAt = serverTimestamp();
  return safeSet(doc(colPolys, obj.id), obj);
}

export function deletePolygonFromCloud(id) {
  return safeDelete(doc(colPolys, id));
}

//
// ---------------- CLOUD LISTENERS (REALTIME) ------------------
//

export function listenToCloudChanges(callbacks) {

  // MARKERS
  onSnapshot(colMarkers, snap => {
    snap.docChanges().forEach(change => {
      const d = change.doc.data();
      if (!d) return;
      if (change.type === "added" || change.type === "modified") {
        callbacks.onMarkerUpdate?.(d);
      } else {
        callbacks.onMarkerDelete?.(d.id);
      }
    });
  });

  // LINES
  onSnapshot(colLines, snap => {
    snap.docChanges().forEach(change => {
      const d = change.doc.data();
      if (!d) return;
      if (change.type === "added" || change.type === "modified") {
        callbacks.onLineUpdate?.(d);
      } else {
        callbacks.onLineDelete?.(d.id);
      }
    });
  });

  // SECTORS
  onSnapshot(colSectors, snap => {
    snap.docChanges().forEach(change => {
      const d = change.doc.data();
      if (!d) return;
      if (change.type === "added" || change.type === "modified") {
        callbacks.onSectorUpdate?.(d);
      } else {
        callbacks.onSectorDelete?.(d.id);
      }
    });
  });

  // POLYGONS
  onSnapshot(colPolys, snap => {
    snap.docChanges().forEach(change => {
      const d = change.doc.data();
      if (!d) return;
      if (change.type === "added" || change.type === "modified") {
        callbacks.onPolygonUpdate?.(d);
      } else {
        callbacks.onPolygonDelete?.(d.id);
      }
    });
  });
}