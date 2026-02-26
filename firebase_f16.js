
import { firebase_f16.js';
import { initializeApp } from 'https://www.gstatic.com/firebase_f16.js/10.11.0/firebase_f16.js';
import { getFirestore, enableMultiTabIndexedDbPersistence } from 'https://www.gstatic.com/firebase_f16.js/10.11.0/firebase_f16.js';
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
if (!window.__hm_persistence_set) { window.__hm_persistence_set = true; enableMultiTabIndexedDbPersistence(db).catch(()=>{}); }
