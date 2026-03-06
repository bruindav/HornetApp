// admin.js — Fix 27
// Wijziging t.o.v. Fix 26:
// - Welkomst-email via EmailJS (client-side) i.p.v. Firebase Trigger Email extensie
// - sendWelcomeEmail() gebruikt emailjs.send() via CDN
// - Geen Firestore 'mail' collectie meer nodig
// - EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY bovenaan instellen

import { auth } from './firebase.js';
import { getFirestore, collection, doc, setDoc, onSnapshot, query, getDoc, deleteDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app } from './firebase.js';

const db = getFirestore(app);

// ======================= EmailJS configuratie =======================
// Vul deze drie waarden in na aanmaken account op emailjs.com
const EMAILJS_SERVICE_ID  = 'JOUW_SERVICE_ID';   // bv. 'service_abc123'
const EMAILJS_TEMPLATE_ID = 'JOUW_TEMPLATE_ID';  // bv. 'template_xyz789'
const EMAILJS_PUBLIC_KEY  = 'JOUW_PUBLIC_KEY';   // bv. 'user_AbCdEfGh'

const KNOWN_ZONES = [
  'Hoornaar_Zeist',
  'Hoornaar_Bilthoven',
  'Hoornaar_Driebergen',
  'Hoornaar_Utrecht',
];

const ACCEPTED_ROLES = ['volunteer', 'manager', 'admin'];

let _unsubUsers = null;
let _adminUid   = null;

// ======================= Overlay =======================
function createOverlay() {
  if (document.getElementById('admin-overlay')) return;
  const el = document.createElement('div');
  el.id = 'admin-overlay';
  el.innerHTML = `
    <div id="admin-panel">
      <div id="admin-header">
        <strong>⚙️ Gebruikersbeheer</strong>
        <button id="admin-close" title="Sluiten">✕</button>
      </div>
      <div id="admin-body"><p style="color:#64748b;padding:12px">Laden…</p></div>
      <p id="admin-footer">
        Nieuwe gebruikers verschijnen hier als <em>pending</em> na hun eerste login.
      </p>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('admin-close').addEventListener('click', closeAdminOverlay);
  el.addEventListener('click', e => { if (e.target === el) closeAdminOverlay(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAdminOverlay(); });
}

function setAdminBody(html) {
  const body = document.getElementById('admin-body');
  if (body) body.innerHTML = html;
}

export async function openAdminOverlay() {
  const uid = auth.currentUser?.uid;
  if (!uid) { alert('Niet ingelogd.'); return; }
  _adminUid = uid;

  createOverlay();
  document.getElementById('admin-overlay').classList.add('open');
  setAdminBody('<p style="color:#64748b;padding:12px">Controleren…</p>');

  let myRole;
  try {
    const mySnap = await getDoc(doc(db, 'roles', uid));
    myRole = mySnap.data()?.role;
  } catch (e) {
    setAdminBody(`<p style="color:red;padding:12px">Fout bij rolcheck: ${e.code} — ${e.message}</p>`);
    return;
  }

  if (myRole !== 'admin') {
    setAdminBody(`<p style="color:red;padding:12px">Geen toegang. Jouw rol is: "${myRole}"</p>`);
    return;
  }

  startListening();
}

function closeAdminOverlay() {
  document.getElementById('admin-overlay')?.classList.remove('open');
  if (_unsubUsers) { _unsubUsers(); _unsubUsers = null; }
}

function startListening() {
  if (_unsubUsers) _unsubUsers();
  _unsubUsers = onSnapshot(query(collection(db, 'roles')), snap => {
    renderTable(snap.docs.map(d => ({ uid: d.id, ...d.data() })));
  }, err => {
    setAdminBody(`<p style="color:red;padding:12px">Fout: ${err.code} — ${err.message}</p>`);
  });
}

// ======================= Tabel =======================
function renderTable(users) {
  if (!users.length) {
    setAdminBody('<p style="color:#64748b;padding:12px">Nog geen gebruikers.</p>');
    return;
  }

  users.sort((a, b) => {
    if (a.role === 'pending' && b.role !== 'pending') return -1;
    if (b.role === 'pending' && a.role !== 'pending') return 1;
    return (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '');
  });

  const rows = users.map(u => {
    const zones      = Array.isArray(u.zones) ? u.zones : [];
    const isPending  = !u.role || u.role === 'pending';
    const isAccepted = ACCEPTED_ROLES.includes(u.role);
    const isSelf     = u.uid === _adminUid;

    // --- Naam-cel ---
    const nameCell = `
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <span id="dn-text-${u.uid}"><strong>${u.displayName || '<em style="color:#94a3b8">geen naam</em>'}</strong></span>
          <button class="adm-btn-icon" title="Naam bewerken" onclick="adminEditName('${u.uid}','${(u.displayName||'').replace(/'/g,"\\'")}')">✏️</button>
        </div>
        <div class="adm-muted">${u.email || u.uid}</div>
        ${isSelf ? '<div style="color:#0aa879;font-size:11px">(jouw account)</div>' : ''}
      </td>`;

    // --- Rol-cel ---
    let rolCell;
    if (isPending) {
      rolCell = `
        <td>
          <span style="color:#f59e0b;font-weight:600">⏳ Pending</span>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="adm-btn-accept" onclick="adminOpenAcceptDialog('${u.uid}','${u.email||''}','${(u.displayName||'').replace(/'/g,"\\'")}')">✓ Accepteren</button>
            <button class="adm-btn-reject" onclick="adminRejectUser('${u.uid}','${u.displayName||u.email||''}')">✕ Weigeren</button>
          </div>
        </td>`;
    } else {
      const deleteBtn = isAccepted && !isSelf
        ? `<button class="adm-btn-delete" onclick="adminDeleteUser('${u.uid}','${u.displayName||u.email||''}')">🗑️ Verwijderen</button>`
        : '';
      rolCell = `
        <td>
          <select class="adm-sel" onchange="adminSetRole('${u.uid}', this.value)">
            <option value="volunteer" ${u.role==='volunteer'?'selected':''}>👤 Vrijwilliger</option>
            <option value="manager"   ${u.role==='manager'  ?'selected':''}>🗂️ Beheerder</option>
            <option value="admin"     ${u.role==='admin'    ?'selected':''}>⭐ Admin</option>
          </select>
          <div style="margin-top:6px">${deleteBtn}</div>
        </td>`;
    }

    // --- Zones-cel ---
    const zoneTags = zones.map(z => `
      <span class="adm-tag">${z.replace('Hoornaar_','')}
        <button class="adm-tag-rm" onclick="adminRemoveZone('${u.uid}','${z}')">×</button>
      </span>`).join('');
    const available = KNOWN_ZONES.filter(z => !zones.includes(z));
    const zoneAdd = available.length
      ? `<div class="adm-zone-add">
           <select id="zadd-${u.uid}">
             ${available.map(z=>`<option value="${z}">${z.replace('Hoornaar_','')}</option>`).join('')}
           </select>
           <button onclick="adminAddZone('${u.uid}')">+ Gebied</button>
         </div>`
      : '<span class="adm-muted">Alle gebieden toegewezen</span>';

    return `<tr class="${isPending?'adm-row-pending':''}">${nameCell}${rolCell}<td><div class="adm-zones">${zoneTags}${zoneAdd}</div></td></tr>`;
  }).join('');

  setAdminBody(`
    <table class="adm-table">
      <thead><tr><th>Gebruiker</th><th>Rol</th><th>Gebieden</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
}

// ======================= Accepteer-dialoog =======================
window.adminOpenAcceptDialog = (uid, email, currentName) => {
  document.getElementById('adm-accept-dialog')?.remove();

  const zonesOptions = KNOWN_ZONES.map(z =>
    `<label style="display:block;margin:3px 0">
      <input type="checkbox" name="adz" value="${z}"> ${z.replace('Hoornaar_','')}
     </label>`
  ).join('');

  const dlg = document.createElement('div');
  dlg.id = 'adm-accept-dialog';
  dlg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10001;display:grid;place-items:center';
  dlg.innerHTML = `
    <div style="background:#fff;border-radius:10px;padding:24px;min-width:320px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2)">
      <h3 style="margin:0 0 16px">Gebruiker accepteren</h3>
      <div style="color:#64748b;font-size:13px;margin-bottom:16px">${email}</div>

      <label style="display:block;margin-bottom:12px">
        <span style="font-size:13px;color:#475569">Naam (weergavenaam)</span>
        <input id="adm-acc-name" type="text" value="${currentName}"
          placeholder="Volledige naam"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px"/>
      </label>

      <label style="display:block;margin-bottom:12px">
        <span style="font-size:13px;color:#475569">Rol</span>
        <select id="adm-acc-role" style="display:block;width:100%;margin-top:4px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px">
          <option value="volunteer">👤 Vrijwilliger</option>
          <option value="manager">🗂️ Beheerder</option>
          <option value="admin">⭐ Admin</option>
        </select>
      </label>

      <div style="margin-bottom:16px">
        <span style="font-size:13px;color:#475569">Gebied(en)</span>
        <div style="margin-top:6px;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
          ${zonesOptions}
        </div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button onclick="document.getElementById('adm-accept-dialog').remove()"
          style="padding:8px 16px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer">Annuleren</button>
        <button id="adm-acc-confirm"
          style="padding:8px 16px;border:0;border-radius:6px;background:#0aa879;color:#fff;font-weight:600;cursor:pointer">✓ Accepteren</button>
      </div>
    </div>`;

  document.body.appendChild(dlg);

  document.getElementById('adm-acc-confirm').addEventListener('click', async () => {
    const name  = document.getElementById('adm-acc-name').value.trim();
    const role  = document.getElementById('adm-acc-role').value;
    const zones = [...document.querySelectorAll('#adm-accept-dialog input[name="adz"]:checked')]
                    .map(cb => cb.value);
    dlg.remove();
    await adminConfirmAccept(uid, email, name, role, zones);
  });
};

async function adminConfirmAccept(uid, email, name, role, zones) {
  try {
    await setDoc(doc(db, 'roles', uid), { role, zones, displayName: name }, { merge: true });
    await sendWelcomeEmail(email, name, role, zones);
  } catch (e) {
    alert(`Accepteren mislukt: ${e.message}`);
  }
}

// ======================= Welkomst-email via EmailJS =======================
async function sendWelcomeEmail(email, displayName, role, zones) {
  if (!email) return;

  // EmailJS laden via CDN als het nog niet geladen is
  if (!window.emailjs) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    window.emailjs.init(EMAILJS_PUBLIC_KEY);
  }

  const roleLabels = { volunteer: 'Vrijwilliger', manager: 'Beheerder', admin: 'Admin' };
  const roleLabel  = roleLabels[role] || role;
  const name       = displayName || email;
  const zonesText  = zones.length
    ? zones.map(z => z.replace('Hoornaar_', '')).join(', ')
    : '(nog geen gebied toegewezen)';

  try {
    await window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email:    email,
      to_name:     name,
      user_role:   roleLabel,
      user_zones:  zonesText,
    });
    console.log(`[admin] welkomstmail verstuurd naar ${email}`);
  } catch (e) {
    console.error('[admin] welkomstmail mislukt:', e);
    // Geen alert — email mislukken mag de acceptatie niet blokkeren
  }
}

// ======================= Naam bewerken =======================
window.adminEditName = async (uid, currentName) => {
  const newName = prompt('Weergavenaam:', currentName);
  if (newName === null) return;
  try {
    await setDoc(doc(db, 'roles', uid), { displayName: newName.trim() }, { merge: true });
  } catch (e) {
    alert(`Naam opslaan mislukt: ${e.message}`);
  }
};

// ======================= Rol wijzigen (al geaccepteerde gebruiker) =======================
window.adminSetRole = async (uid, newRole) => {
  try {
    await setDoc(doc(db, 'roles', uid), { role: newRole }, { merge: true });
  } catch (e) {
    alert(`Rol instellen mislukt: ${e.message}`);
  }
};

// ======================= Verwijderen =======================
window.adminRejectUser = async (uid, name) => {
  if (!confirm(`Gebruiker "${name}" weigeren en verwijderen?`)) return;
  try {
    await deleteDoc(doc(db, 'roles', uid));
  } catch (e) {
    alert(`Weigeren mislukt: ${e.message}`);
  }
};

window.adminDeleteUser = async (uid, name) => {
  if (uid === _adminUid) { alert('Je kunt jezelf niet verwijderen.'); return; }
  if (!confirm(`Gebruiker "${name}" definitief verwijderen?\nDit verwijdert hun toegang maar niet hun kaartdata.`)) return;
  try {
    await deleteDoc(doc(db, 'roles', uid));
  } catch (e) {
    alert(`Verwijderen mislukt: ${e.message}`);
  }
};

// ======================= Zones =======================
window.adminAddZone = async (uid) => {
  const sel = document.getElementById(`zadd-${uid}`);
  if (!sel) return;
  const zone = sel.value;
  try {
    const snap  = await getDoc(doc(db, 'roles', uid));
    const zones = Array.isArray(snap.data()?.zones) ? snap.data().zones : [];
    if (!zones.includes(zone))
      await setDoc(doc(db, 'roles', uid), { zones: [...zones, zone] }, { merge: true });
  } catch (e) {
    alert(`Gebied toevoegen mislukt: ${e.message}`);
  }
};

window.adminRemoveZone = async (uid, zone) => {
  try {
    const snap  = await getDoc(doc(db, 'roles', uid));
    const zones = (snap.data()?.zones || []).filter(z => z !== zone);
    await setDoc(doc(db, 'roles', uid), { zones }, { merge: true });
  } catch (e) {
    alert(`Gebied verwijderen mislukt: ${e.message}`);
  }
};
