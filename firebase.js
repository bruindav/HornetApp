// firebase.js — Fix 15 — Google + email/wachtwoord authenticatie
import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { firebaseConfig } from './config.js';

export const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Google login
export function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

// Email registreren
export async function registerWithEmail(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName: name });
  return cred.user;
}

// Email inloggen
export function loginWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}
