// main.js — Fix 9 — betere boot guard tegen dubbele initialisatie
import { auth } from './firebase.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

function showLogin(){
  document.getElementById('login-screen')?.classList.remove('hidden');
  document.getElementById('app-shell')?.classList.add('hidden');
}
function showApp(){
  document.getElementById('login-screen')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
}
function renderHeader(user){
  const who = document.getElementById('hdr-user');
  if (who) who.textContent = user?.displayName || user?.email || user?.uid || 'Onbekend';
}

let _bootPromise = null;

async function startAppOnce(){
  // Als al bezig of al klaar → niet opnieuw starten
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    const mod = await import('./app-core.js');
    mod.boot();
  })();
  return _bootPromise;
}

// Bind login / logout buttons
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginBtn')?.addEventListener('click', async () => {
    const { loginWithGoogle } = await import('./firebase.js');
    await loginWithGoogle();
  });
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    _bootPromise = null; // reset zodat na opnieuw inloggen app opnieuw boot
    signOut(auth);
  });
});

// Auth state gate
onAuthStateChanged(auth, (user) => {
  if (user) {
    showApp();
    renderHeader(user);
    startAppOnce();
  } else {
    showLogin();
    _bootPromise = null;
  }
});
