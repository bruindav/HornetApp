// main.js — Fix 17 — pending gebruikers krijgen wachtscherm, geen kaart
import { auth, loginWithGoogle, loginWithEmail, registerWithEmail } from './firebase.js';
import { onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app } from './firebase.js';

const db = getFirestore(app);

function friendlyError(code) {
  const map = {
    'auth/invalid-email':          'Ongeldig e-mailadres.',
    'auth/user-not-found':         'Geen account gevonden met dit e-mailadres.',
    'auth/wrong-password':         'Onjuist wachtwoord.',
    'auth/invalid-credential':     'E-mail of wachtwoord klopt niet.',
    'auth/email-already-in-use':   'Dit e-mailadres is al in gebruik.',
    'auth/weak-password':          'Wachtwoord moet minimaal 6 tekens zijn.',
    'auth/too-many-requests':      'Te veel pogingen. Probeer later opnieuw.',
    'auth/popup-closed-by-user':   'Inloggen geannuleerd.',
    'auth/network-request-failed': 'Netwerkfout. Controleer je verbinding.',
  };
  return map[code] || 'Er is een fout opgetreden. Probeer opnieuw.';
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.classList.add('show'); }
}

function showScreen(id) {
  ['login-screen','pending-screen','app-shell'].forEach(s => {
    document.getElementById(s)?.classList.toggle('hidden', s !== id);
  });
}

function renderHeader(user) {
  const who = document.getElementById('hdr-user');
  if (who) who.textContent = user?.displayName || user?.email || '–';
}

async function renderAdminLink(uid) {
  try {
    const snap = await getDoc(doc(db, 'roles', uid));
    if (snap.exists() && snap.data().role === 'admin') {
      if (!document.getElementById('admin-btn')) {
        const btn = document.createElement('button');
        btn.id = 'admin-btn';
        btn.textContent = '⚙️ Beheer';
        btn.style.cssText = 'background:none;border:1px solid #475569;color:#94a3b8;border-radius:4px;padding:4px 10px;font-size:13px;cursor:pointer;';
        btn.onmouseover = () => btn.style.color = '#fff';
        btn.onmouseout  = () => btn.style.color = '#94a3b8';
        btn.addEventListener('click', async () => {
          const { openAdminOverlay } = await import('./admin.js');
          openAdminOverlay();
        });
        const hdr = document.querySelector('header');
        const logout = document.getElementById('logoutBtn');
        if (hdr && logout) hdr.insertBefore(btn, logout);
      }
    }
  } catch {}
}

async function autoRegisterUser(user) {
  try {
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
    }
  } catch (e) {
    console.warn('[auth] auto-register mislukt:', e.message);
  }
}

let _bootPromise = null;
async function startAppOnce() {
  if (_bootPromise) return _bootPromise;
  _bootPromise = (async () => {
    const mod = await import('./app-core.js');
    mod.boot();
  })();
  return _bootPromise;
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginEmailBtn')?.addEventListener('click', async () => {
    const email    = document.getElementById('login-email')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    if (!email || !password) { showAuthError('Vul e-mail en wachtwoord in.'); return; }
    document.getElementById('loginEmailBtn').disabled = true;
    try {
      await loginWithEmail(email, password);
    } catch (e) {
      showAuthError(friendlyError(e.code));
      document.getElementById('loginEmailBtn').disabled = false;
    }
  });

  document.getElementById('loginGoogleBtn')?.addEventListener('click', async () => {
    try { await loginWithGoogle(); }
    catch (e) { showAuthError(friendlyError(e.code)); }
  });

  document.getElementById('registerBtn')?.addEventListener('click', async () => {
    const name     = document.getElementById('reg-name')?.value?.trim();
    const email    = document.getElementById('reg-email')?.value?.trim();
    const password = document.getElementById('reg-password')?.value;
    if (!name)     { showAuthError('Vul je naam in.'); return; }
    if (!email)    { showAuthError('Vul je e-mailadres in.'); return; }
    if (!password) { showAuthError('Vul een wachtwoord in.'); return; }
    document.getElementById('registerBtn').disabled = true;
    try {
      await registerWithEmail(name, email, password);
    } catch (e) {
      showAuthError(friendlyError(e.code));
      document.getElementById('registerBtn').disabled = false;
    }
  });

  document.getElementById('registerGoogleBtn')?.addEventListener('click', async () => {
    try { await loginWithGoogle(); }
    catch (e) { showAuthError(friendlyError(e.code)); }
  });

  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    _bootPromise = null;
    signOut(auth);
  });

  document.getElementById('pending-logout')?.addEventListener('click', () => {
    _bootPromise = null;
    signOut(auth);
  });
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    showScreen('login-screen');
    _bootPromise = null;
    return;
  }

  // Registreer als pending als nog niet bekend
  await autoRegisterUser(user);

  // Controleer rol
  let role = 'pending';
  try {
    const snap = await getDoc(doc(db, 'roles', user.uid));
    role = snap.data()?.role || 'pending';
  } catch {}

  if (role === 'pending') {
    // Wachtscherm tonen — geen toegang tot kaart
    showScreen('pending-screen');
    const nameEl = document.getElementById('pending-name');
    if (nameEl) nameEl.textContent = user.displayName || user.email || 'Gebruiker';
  } else {
    // Toegang tot app
    showScreen('app-shell');
    renderHeader(user);
    await renderAdminLink(user.uid);
    startAppOnce();
  }
});
