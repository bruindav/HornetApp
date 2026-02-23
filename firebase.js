
// firebase.js — laadt config uit config.js

import { firebaseConfig } from "./config.js";

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";

import {
  getFirestore,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

export const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);

// Offline-first persistence
enableIndexedDbPersistence(db).catch((err) => {
  console.warn("Kon IndexedDB persistence niet inschakelen:", err);
});

