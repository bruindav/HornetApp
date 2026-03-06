// admin.js — Fix 25 — verwijder knop + welkomst-email via Trigger Email
import { auth } from './firebase.js';
import { getFirestore, collection, doc, setDoc, addDoc, onSnapshot, query, getDoc, deleteDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app } from './firebase.js';

const db = getFirestore(app);

const KNOWN_ZONES = [
  'Hoornaar_Zeist',
  'Hoornaar_Bilthoven',
  'Hoornaar_Driebergen',
  'Hoornaar_Utrecht',
];

// Rollen die als "geaccepteerd" gelden (niet pending)
const ACCEPTED_ROLES = ['volunteer', 'manager', 'admin'];

let _unsubUsers = null;
let _adminUid   = null; // uid van ingelogde admin, zodat die niet verwijderd kan worden

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
    console.log('[admin] eigen rol:', myRole, '| uid:', uid);
  } catch (e) {
    console.error('[admin] eigen rol lezen mislukt:', e.code, e.message);
    setAdminBody(`<p style="color:red;padding:12px">Fout bij rolcheck: ${e.code} — ${e.message}</p>`);
    return;
  }

  if (myRole !== 'admin') {
    setAdminBody(`<p style="color:red;padding:12px">Geen toegang. Jouw rol is: "${myRole}"</p>`);
    return;
  }

  console.log('[admin] rol OK, roles collectie ophalen...');
  startListening();
}

function closeAdminOverlay() {
  document.getElementById('admin-overlay')?.classList.remove('open');
  if (_unsubUsers) { _unsubUsers(); _unsubUsers = null; }
}

function startListening() {
  if (_unsubUsers) _unsubUsers();
  const rolesRef = collection(db, 'roles');
  _unsubUsers = onSnapshot(query(rolesRef), snap => {
    console.log('[admin] snapshot ontvangen, docs:', snap.docs.length);
    const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderTable(users);
  }, err => {
    console.error('[admin] onSnapshot fout:', err.code, err.message);
    setAdminBody(`<p style="color:red;padding:12px">Fout: ${err.code} — ${err.message}</p>`);
  });
}

function renderTable(users) {
  if (users.length === 0) {
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

    const zoneTags = zones.map(z => `
      <span class="adm-tag">${z}
        <button class="adm-tag-rm" onclick="adminRemoveZone('${u.uid}','${z}')">×</button>
      </span>`).join('');

    const available = KNOWN_ZONES.filter(z => !zones.includes(z));
    const zoneAdd = available.length
      ? `<div class="adm-zone-add">
           <select id="zadd-${u.uid}">
             ${available.map(z => `<option value="${z}">${z.replace('Hoornaar_','')}</option>`).join('')}
           </select>
           <button onclick="adminAddZone('${u.uid}')">+ Gebied</button>
         </div>`
      : '<span class="adm-muted">Alle gebieden toegewezen</span>';

    // Acties onderaan de rol-kolom
    const rejectBtn  = isPending
      ? `<button class="adm-btn-reject" onclick="adminRejectUser('${u.uid}','${u.displayName||u.email||''}')">✕ Weigeren</button>`
      : '';
    // Verwijder-knop: alleen voor geaccepteerde gebruikers, nooit voor jezelf
    const deleteBtn  = isAccepted && !isSelf
      ? `<button class="adm-btn-delete" onclick="adminDeleteUser('${u.uid}','${u.displayName||u.email||''}')">🗑️ Verwijderen</button>`
      : '';

    return `
      <tr class="${isPending ? 'adm-row-pending' : ''}">
        <td>
          <strong>${u.displayName || '—'}</strong>
          <div class="adm-muted">${u.email || u.uid}</div>
          ${isSelf ? '<div class="adm-muted" style="color:#0aa879">(jouw account)</div>' : ''}
        </td>
        <td>
          <select class="adm-sel" onchange="adminSetRole('${u.uid}','${u.email||''}','${u.displayName||''}', this.value, ${JSON.stringify(zones)})">
            <option value="pending"   ${(u.role||'pending')==='pending'  ?'selected':''}>⏳ Pending</option>
            <option value="volunteer" ${u.role==='volunteer'?'selected':''}>👤 Vrijwilliger</option>
            <option value="manager"   ${u.role==='manager'  ?'selected':''}>🗂️ Beheerder</option>
            <option value="admin"     ${u.role==='admin'    ?'selected':''}>⭐ Admin</option>
          </select>
          <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
            ${rejectBtn}${deleteBtn}
          </div>
        </td>
        <td><div class="adm-zones">${zoneTags}${zoneAdd}</div></td>
      </tr>`;
  }).join('');

  setAdminBody(`
    <table class="adm-table">
      <thead><tr><th>Gebruiker</th><th>Rol</th><th>Gebieden</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
}

// ======================= Welkomst-email =======================
async function sendWelcomeEmail(email, displayName, role, zones) {
  if (!email) { console.warn('[admin] geen email adres, welkomstmail overgeslagen'); return; }

  const roleLabels = { volunteer: 'Vrijwilliger', manager: 'Beheerder', admin: 'Admin' };
  const roleLabel  = roleLabels[role] || role;
  const zonesText  = zones.length
    ? zones.map(z => `• ${z.replace('Hoornaar_', '')}`).join('\n')
    : '(nog geen gebied toegewezen)';
  const name = displayName || email;

  try {
    await addDoc(collection(db, 'mail'), {
      to: email,
      message: {
        subject: 'Toegang verleend – HornetApp',
        text: `Hallo ${name},\n\nJe toegang tot HornetApp is goedgekeurd.\n\nJouw rol: ${roleLabel}\nJouw gebied(en):\n${zonesText}\n\nJe kunt nu inloggen via de app.\n\nMet vriendelijke groet,\nHet HornetApp-team`,
        html: `
          <p>Hallo <strong>${name}</strong>,</p>
          <p>Je toegang tot <strong>HornetApp</strong> is goedgekeurd.</p>
          <table style="border-collapse:collapse;margin:12px 0">
            <tr><td style="padding:4px 12px 4px 0;color:#64748b">Rol</td><td><strong>${roleLabel}</strong></td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top">Gebied(en)</td>
                <td>${zones.length ? zones.map(z=>`<strong>${z.replace('Hoornaar_','')}</strong>`).join(', ') : '<em>nog geen gebied toegewezen</em>'}</td></tr>
          </table>
          <p>Je kunt nu inloggen via de app.</p>
          <p style="color:#64748b;font-size:13px">Met vriendelijke groet,<br>Het HornetApp-team</p>`,
      },
    });
    console.log(`[admin] welkomstmail verstuurd naar ${email}`);
  } catch (e) {
    console.error('[admin] welkomstmail mislukt:', e.code, e.message);
  }
}

// ======================= Window-functies (aangeroepen vanuit HTML) =======================

// Rol wijzigen — stuur welkomstmail als van pending → geaccepteerde rol
window.adminSetRole = async (uid, email, displayName, newRole, zones) => {
  try {
    const snap = await getDoc(doc(db, 'roles', uid));
    const oldRole = snap.data()?.role || 'pending';
    await setDoc(doc(db, 'roles', uid), { role: newRole }, { merge: true });

    // Welkomstmail sturen als gebruiker voor het eerst geaccepteerd wordt
    const wassPending = !oldRole || oldRole === 'pending';
    const isNowAccepted = ACCEPTED_ROLES.includes(newRole);
    if (wassPending && isNowAccepted) {
      await sendWelcomeEmail(email, displayName, newRole, zones);
    }
  } catch (e) {
    alert(`Rol instellen mislukt: ${e.message}`);
  }
};

// Pending gebruiker weigeren en verwijderen
window.adminRejectUser = async (uid, name) => {
  if (!confirm(`Gebruiker "${name}" weigeren en verwijderen?`)) return;
  try {
    await deleteDoc(doc(db, 'roles', uid));
  } catch (e) {
    alert(`Weigeren mislukt: ${e.message}`);
  }
};

// Geaccepteerde gebruiker verwijderen (niet jezelf)
window.adminDeleteUser = async (uid, name) => {
  if (uid === _adminUid) { alert('Je kunt jezelf niet verwijderen.'); return; }
  if (!confirm(`Gebruiker "${name}" definitief verwijderen? Dit verwijdert hun toegang maar niet hun kaartdata.`)) return;
  try {
    await deleteDoc(doc(db, 'roles', uid));
  } catch (e) {
    alert(`Verwijderen mislukt: ${e.message}`);
  }
};

window.adminAddZone = async (uid) => {
  const sel = document.getElementById(`zadd-${uid}`);
  if (!sel) return;
  const zone = sel.value;
  try {
    const snap = await getDoc(doc(db, 'roles', uid));
    const zones = Array.isArray(snap.data()?.zones) ? snap.data().zones : [];
    if (!zones.includes(zone)) {
      await setDoc(doc(db, 'roles', uid), { zones: [...zones, zone] }, { merge: true });
    }
  } catch (e) {
    alert(`Gebied toevoegen mislukt: ${e.message}`);
  }
};

window.adminRemoveZone = async (uid, zone) => {
  try {
    const snap = await getDoc(doc(db, 'roles', uid));
    const zones = (snap.data()?.zones || []).filter(z => z !== zone);
    await setDoc(doc(db, 'roles', uid), { zones }, { merge: true });
  } catch (e) {
    alert(`Gebied verwijderen mislukt: ${e.message}`);
  }
};
