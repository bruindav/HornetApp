 
                                 
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { 
  getFirestore,
  enableMultiTabIndexedDbPersistence 
} from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

// Init app
export const app = initializeApp(firebaseConfig);

// Init Firestore
export const db = getFirestore(app);

// Persistence guard (voorkomt dubbele aanroep)
if (!window.__hm_persistence_set) {
  window.__hm_persistence_set = true;
  enableMultiTabIndexedDbPersistence(db).catch(() => {});
}

