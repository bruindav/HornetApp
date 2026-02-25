
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getFirestore, enableMultiTabIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
if (!window.__hm_persistence_set) { window.__hm_persistence_set = true; enableMultiTabIndexedDbPersistence(db).catch(()=>{}); }
