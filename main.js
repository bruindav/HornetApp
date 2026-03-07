// main.js — Fix 34
// Auth-gated bootstrap met email/wachtwoord + Google login
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
async function startAppOnce(){
  if (window.__hornetAppBooted) return;
  window.__hornetAppBooted = true;
  const mod = await import('./app-core.js');
  mod.boot();
}

function reloadApp(){
  // Na uitloggen/inloggen: harde reload om kaart-herinitialisatie te voorkomen
  location.reload();
}

function showError(msg) {
  const el = document.getElementById('login-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function clearError() {
  const el = document.getElementById('login-error');
  if (el) el.classList.add('hidden');
}

window.addEventListener('DOMContentLoaded', () => {
  // Tab wisselen
  document.getElementById('tab-login')?.addEventListener('click', () => {
    document.getElementById('tab-login').classList.add('active');
    document.getElementById('tab-register').classList.remove('active');
    document.getElementById('panel-login').classList.remove('hidden');
    document.getElementById('panel-register').classList.add('hidden');
    clearError();
  });
  document.getElementById('tab-register')?.addEventListener('click', () => {
    document.getElementById('tab-register').classList.add('active');
    document.getElementById('tab-login').classList.remove('active');
    document.getElementById('panel-register').classList.remove('hidden');
    document.getElementById('panel-login').classList.add('hidden');
    clearError();
  });

  // Google login
  document.querySelectorAll('.btn-google').forEach(btn => {
    btn.addEventListener('click', async () => {
      clearError();
      try {
        const { loginWithGoogle } = await import('./firebase.js');
        await loginWithGoogle();
      } catch(e) { showError(firebaseErrorNL(e.code)); }
    });
  });

  // Email inloggen
  document.getElementById('btn-login-email')?.addEventListener('click', async () => {
    clearError();
    const email = document.getElementById('login-email')?.value.trim();
    const pass  = document.getElementById('login-pass')?.value;
    if (!email || !pass) { showError('Vul e-mail en wachtwoord in.'); return; }
    try {
      const { loginWithEmail } = await import('./firebase.js');
      await loginWithEmail(email, pass);
    } catch(e) { showError(firebaseErrorNL(e.code)); }
  });

  // Email registreren
  document.getElementById('btn-register-email')?.addEventListener('click', async () => {
    clearError();
    const email = document.getElementById('reg-email')?.value.trim();
    const pass  = document.getElementById('reg-pass')?.value;
    const pass2 = document.getElementById('reg-pass2')?.value;
    if (!email || !pass) { showError('Vul e-mail en wachtwoord in.'); return; }
    if (pass !== pass2)  { showError('Wachtwoorden komen niet overeen.'); return; }
    if (pass.length < 6) { showError('Wachtwoord moet minimaal 6 tekens zijn.'); return; }
    try {
      const { registerWithEmail } = await import('./firebase.js');
      await registerWithEmail(email, pass);
    } catch(e) { showError(firebaseErrorNL(e.code)); }
  });

  // Wachtwoord vergeten
  document.getElementById('btn-forgot')?.addEventListener('click', async () => {
    const email = document.getElementById('login-email')?.value.trim();
    if (!email) { showError('Vul eerst je e-mailadres in.'); return; }
    try {
      const { resetPassword } = await import('./firebase.js');
      await resetPassword(email);
      showError('Reset-link verstuurd! Controleer je inbox.');
    } catch(e) { showError(firebaseErrorNL(e.code)); }
  });

  // Uitloggen
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await signOut(auth);
    reloadApp();
  });
});

function firebaseErrorNL(code) {
  const map = {
    'auth/user-not-found':       'Geen account gevonden met dit e-mailadres.',
    'auth/wrong-password':       'Onjuist wachtwoord.',
    'auth/email-already-in-use': 'Dit e-mailadres is al in gebruik.',
    'auth/invalid-email':        'Ongeldig e-mailadres.',
    'auth/weak-password':        'Wachtwoord is te zwak (min. 6 tekens).',
    'auth/too-many-requests':    'Te veel pogingen. Probeer later opnieuw.',
    'auth/popup-closed-by-user': 'Inloggen geannuleerd.',
    'auth/invalid-credential':   'E-mail of wachtwoord onjuist.',
  };
  return map[code] || `Fout: ${code}`;
}

// Auth state gate
onAuthStateChanged(auth, (user) => {
  if (user) {
    showApp();
    renderHeader(user);
    startAppOnce();
  } else {
    showLogin();
    // Niet resetten — bij opnieuw inloggen herladen we de pagina via logoutBtn
  }
});
