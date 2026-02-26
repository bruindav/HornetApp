import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js';
import { getFirestore, enableMultiTabIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';

// Initialize Firebase app and Firestore
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Enable multi-tab IndexedDB persistence (ignore if not supported)
(async () => {
  try {
    if (!window.__hm_persistence_set) {
      window.__hm_persistence_set = true;
      await enableMultiTabIndexedDbPersistence(db);
    }
  } catch (e) {
    // No-op: fallback to in-memory if blocked/not supported
    console.warn('[persistence]', e?.message || e);
  }
})();
