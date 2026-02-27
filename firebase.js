// Firebase redirect auth
import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

import { firebaseConfig } from './config.js';

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

export async function loginWithGoogle(){
  const provider = new GoogleAuthProvider();
  return signInWithRedirect(auth, provider);
}
