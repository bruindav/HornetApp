// firebase.js — Fix 213
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup,
         createUserWithEmailAndPassword, signInWithEmailAndPassword,
         sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { firebaseConfig } from './config.js';

export const app     = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth    = getAuth(app);
export const storage = getStorage(app);

export function loginWithGoogle(forceSelectAccount = false) {
  const provider = new GoogleAuthProvider();
  if (forceSelectAccount) {
    provider.setCustomParameters({ prompt: 'select_account' });
  }
  return signInWithPopup(auth, provider);
}

export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function registerWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

// Fix 213: foto uploaden/verwijderen (gebruikt bij markers en zichtlijnen)
// Met timeout: zonder dit kan een upload bij een verkeerd ingestelde Storage-bucket of
// geblokkeerde rules onbeperkt "hangen" zonder ooit een fout te geven (bekend SDK-gedrag).
function _withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
export async function uploadActionPhoto(blob, path) {
  const storageRef = ref(storage, path);
  try {
    await _withTimeout(
      uploadBytes(storageRef, blob, { contentType: blob.type || 'image/jpeg' }),
      20000, 'Uploaden duurde te lang (20s) — controleer of Firebase Storage is ingeschakeld en of de opslagregels schrijven toestaan.'
    );
  } catch (e) {
    console.error('[uploadActionPhoto] upload mislukt:', e);
    throw e;
  }
  try {
    return await _withTimeout(
      getDownloadURL(storageRef),
      15000, 'Ophalen van de foto-link duurde te lang (15s).'
    );
  } catch (e) {
    console.error('[uploadActionPhoto] getDownloadURL mislukt:', e);
    throw e;
  }
}
export async function deleteActionPhoto(path) {
  try { await deleteObject(ref(storage, path)); } catch { /* al weg, of nooit bestaan — negeren */ }
}
