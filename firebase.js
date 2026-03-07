// firebase.js — Fix 35
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup,
         createUserWithEmailAndPassword, signInWithEmailAndPassword,
         sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { firebaseConfig } from './config.js';

export const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

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
