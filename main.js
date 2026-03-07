// main.js — Fix 24
// Auth-gated bootstrap
import { auth } from './firebase.js';
import { onAuthStateChanged, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// UI helpers: show/hide containers
function showLogin(){
  document.getElementById('login-screen')?.classList.remove('hidden');
  document.getElementById('app-shell')?.classList.add('hidden');
}
function showApp(){
  document.getElementById('login-screen')?.classList.add('hidden');
  document.getElementById('app-shell')?.classList.remove('hidden');
}

// header helpers
function renderHeader(user){
  const who = document.getElementById('hdr-user');
  if (who) who.textContent = user?.displayName || user?.email || user?.uid || 'Onbekend';
}

async function startAppOnce(){
  if (window.__hornetAppBooted) return;
  window.__hornetAppBooted = true;
  const mod = await import('./app-core.js');
  mod.boot();
}

// Bind login / logout buttons
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginBtn')?.addEventListener('click', async () => {
    const { loginWithGoogle } = await import('./firebase.js');
    await loginWithGoogle();
  });
  document.getElementById('logoutBtn')?.addEventListener('click', () => signOut(auth));
});

// Handle redirect result for info only
getRedirectResult(auth).catch(console.error);

// Auth state gate
onAuthStateChanged(auth, (user) => {
  if (user) {
    showApp();
    renderHeader(user);
    startAppOnce();
  } else {
    showLogin();
    window.__hornetAppBooted = false; // user switched – require fresh boot after login
  }
});
