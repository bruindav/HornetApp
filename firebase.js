import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getFirestore, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
export const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);
enableIndexedDbPersistence(db).catch(()=>{});
