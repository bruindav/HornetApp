// admin.js — Fix 20 — uitgebreide foutmelding + getDocs ipv onSnapshot voor debug
import { auth } from './firebase.js';
import { getFirestore, collection, doc, setDoc, onSnapshot, query, getDoc, getDocs }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app } from './firebase.js';

const db = getFirestore(app);

const KNOWN_ZONES = [
  'Hoornaar_Zeist',
  'Hoornaar_Bilthoven',
  'Hoornaar_Driebergen',
  'Hoornaar_Utrecht',
];

let _unsubUsers = null;

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

  createOverlay();
  document.getElementById('admin-overlay').classList.add('open');
  setAdminBody('<p style="color:#64748b;padding:12px">Controleren…</p>');

  // Stap 1: eigen rol checken
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

  // Stap 2: alle gebruikers ophalen
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
    const zones = Array.isArray(u.zones) ? u.zones : [];
    const isPending = !u.role || u.role === 'pending';
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

    return `
      <tr class="${isPending ? 'adm-row-pending' : ''}">
        <td>
          <strong>${u.displayName || '—'}</strong>
          <div class="adm-muted">${u.email || u.uid}</div>
        </td>
        <td>
          <select class="adm-sel" onchange="adminSetRole('${u.uid}', this.value)">
            <option value="pending"   ${(u.role||'pending')==='pending'  ?'selected':''}>⏳ Pending</option>
            <option value="volunteer" ${u.role==='volunteer'?'selected':''}>👤 Vrijwilliger</option>
            <option value="manager"   ${u.role==='manager'  ?'selected':''}>🗂️ Beheerder</option>
            <option value="admin"     ${u.role==='admin'    ?'selected':''}>⭐ Admin</option>
          </select>
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

window.adminSetRole = async (uid, role) => {
  try {
    await setDoc(doc(db, 'roles', uid), { role }, { merge: true });
  } catch (e) {
    alert(`Rol instellen mislukt: ${e.message}`);
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
