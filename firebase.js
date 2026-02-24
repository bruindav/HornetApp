// firebase.js — Firebase + Firestore init (Option A)
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getFirestore, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

export const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);

// Offline-first (niet-blockerend als het faalt)
enableIndexedDbPersistence(db).catch(err=>console.warn('[firebase] IndexedDB persistence niet ingeschakeld:', err));
