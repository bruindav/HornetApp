// main.js — Fix 14 — boot guard + auto-registratie nieuwe gebruikers
import { auth } from './firebase.js';
import { onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app } from './firebase.js';

const db = getFirestore(app);

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
  if (who) who.textContent = user?.displayName || user?.email || '–';
}

// Toon admin-knop alleen voor admins
async function renderAdminLink(uid) {
  const snap = await getDoc(doc(db, 'roles', uid));
  if (snap.exists() && snap.data().role === 'admin') {
    const hdr = document.querySelector('header');
    if (hdr && !document.getElementById('admin-link')) {
      const a = document.createElement('a');
      a.id = 'admin-link';
      a.href = '/admin.html';
      a.textContent = '⚙️ Beheer';
      a.style.cssText = 'color:#94a3b8;text-decoration:none;font-size:13px;margin-left:8px;';
      a.onmouseover = () => a.style.color = '#fff';
      a.onmouseout  = () => a.style.color = '#94a3b8';
      hdr.insertBefore(a, document.getElementById('logoutBtn'));
    }
  }
}

// Registreer nieuwe gebruiker als 'pending' als ze nog geen rol hebben
async function autoRegisterUser(user) {
  const ref = doc(db, 'roles', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      role: 'pending',
      zones: [],
      displayName: user.displayName || '',
      email: user.email || '',
      registeredAt: new Date().toISOString()
    });
    console.log('[auth] Nieuwe gebruiker geregistreerd als pending:', user.email);
  }
}

let _bootPromise = null;

async function startAppOnce(){
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    const mod = await import('./app-core.js');
    mod.boot();
  })();
  return _bootPromise;
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginBtn')?.addEventListener('click', async () => {
    const { loginWithGoogle } = await import('./firebase.js');
    await loginWithGoogle();
  });
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    _bootPromise = null;
    signOut(auth);
  });
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    showApp();
    renderHeader(user);
    await autoRegisterUser(user);
    await renderAdminLink(user.uid);
    startAppOnce();
  } else {
    showLogin();
    _bootPromise = null;
  }
});
