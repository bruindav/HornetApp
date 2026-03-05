// admin.js — Fix 14 — Gebruikersbeheer pagina (alleen voor admins)
import { auth } from './firebase.js';
import { getFirestore, collection, doc, setDoc, onSnapshot, query, getDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const db = getFirestore();

// ── Beschikbare gebieden (pas aan naar jouw situatie) ──────────────
// Dit zijn de 'group' namen zoals je ze in de app invult
const KNOWN_ZONES = [
  'Hoornaar_Zeist',
  'Hoornaar_Bilthoven',
  'Hoornaar_Driebergen',
  'Hoornaar_Utrecht',
];

// ── Bootstrap ──────────────────────────────────────────────────────
export async function bootAdmin() {
  // Controleer of huidige gebruiker admin is
  const uid = auth.currentUser?.uid;
  if (!uid) { showError('Niet ingelogd.'); return; }

  const roleSnap = await getDoc(doc(db, 'roles', uid));
  if (!roleSnap.exists() || roleSnap.data().role !== 'admin') {
    showError('Geen toegang. Alleen admins kunnen deze pagina gebruiken.');
    return;
  }

  renderAdminUI();
  listenToUsers();
}

// ── UI opbouwen ────────────────────────────────────────────────────
function renderAdminUI() {
  document.body.innerHTML = `
    <style>
      * { box-sizing: border-box; }
      body { margin:0; font-family: system-ui, Arial, sans-serif; background:#f1f5f9; }
      header { background:#0f172a; color:#fff; padding:12px 20px; display:flex; align-items:center; gap:16px; }
      header a { color:#94a3b8; text-decoration:none; font-size:14px; }
      header a:hover { color:#fff; }
      h1 { margin:0; font-size:18px; flex:1; }
      .container { max-width:900px; margin:24px auto; padding:0 16px; }
      .card { background:#fff; border-radius:8px; border:1px solid #e2e8f0; overflow:hidden; }
      table { width:100%; border-collapse:collapse; }
      th { background:#f8fafc; text-align:left; padding:10px 14px; font-size:13px; color:#64748b; border-bottom:1px solid #e2e8f0; }
      td { padding:10px 14px; border-bottom:1px solid #f1f5f9; font-size:14px; vertical-align:middle; }
      tr:last-child td { border-bottom:none; }
      tr:hover td { background:#fafafa; }
      select { padding:4px 8px; border:1px solid #cbd5e1; border-radius:4px; font-size:13px; }
      .zones-cell { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
      .zone-tag { background:#dbeafe; color:#1d4ed8; border-radius:12px; padding:2px 10px; font-size:12px; display:flex; align-items:center; gap:4px; }
      .zone-tag button { background:none; border:none; cursor:pointer; color:#1d4ed8; font-size:14px; line-height:1; padding:0; }
      .add-zone { display:flex; gap:6px; align-items:center; margin-top:6px; }
      .add-zone select { font-size:12px; }
      .add-zone button { background:#0f172a; color:#fff; border:none; border-radius:4px; padding:3px 10px; cursor:pointer; font-size:12px; }
      .role-badge { display:inline-block; border-radius:12px; padding:2px 10px; font-size:12px; font-weight:600; }
      .role-admin    { background:#fef9c3; color:#854d0e; }
      .role-manager  { background:#dcfce7; color:#166534; }
      .role-volunteer{ background:#dbeafe; color:#1e40af; }
      .role-pending  { background:#fee2e2; color:#991b1b; }
      .status-msg { padding:12px 16px; font-size:13px; color:#64748b; }
      .error { color:#dc2626; padding:24px; }
    </style>
    <header>
      <h1>🐝 HornetApp — Gebruikersbeheer</h1>
      <a href="/">← Terug naar kaart</a>
    </header>
    <div class="container">
      <h2 style="margin:0 0 12px;font-size:16px;color:#334155">Gebruikers</h2>
      <div class="card">
        <div id="users-table"><div class="status-msg">Laden…</div></div>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin-top:12px">
        Nieuwe gebruikers verschijnen hier als "pending" nadat ze de eerste keer inloggen.
        Wijs een rol en gebieden toe om ze toegang te geven.
      </p>
    </div>
  `;
}

function showError(msg) {
  document.body.innerHTML = `<div class="error">${msg} <a href="/">← Terug</a></div>`;
}

// ── Realtime gebruikerslijst ───────────────────────────────────────
function listenToUsers() {
  const rolesRef = collection(db, 'roles');
  onSnapshot(query(rolesRef), (snap) => {
    const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderTable(users);
  }, err => {
    document.getElementById('users-table').innerHTML =
      `<div class="status-msg" style="color:red">Fout: ${err.message}</div>`;
  });
}

// ── Tabel renderen ────────────────────────────────────────────────
function renderTable(users) {
  if (users.length === 0) {
    document.getElementById('users-table').innerHTML =
      '<div class="status-msg">Nog geen gebruikers. Laat ze eerst inloggen.</div>';
    return;
  }

  // Sorteer: pending eerst, dan op naam
  users.sort((a,b) => {
    if (a.role === 'pending' && b.role !== 'pending') return -1;
    if (b.role === 'pending' && a.role !== 'pending') return 1;
    return (a.displayName||a.email||'').localeCompare(b.displayName||b.email||'');
  });

  const rows = users.map(u => {
    const zones = Array.isArray(u.zones) ? u.zones : [];
    const roleBadge = `<span class="role-badge role-${u.role||'pending'}">${u.role||'pending'}</span>`;
    const zoneTags = zones.map(z =>
      `<span class="zone-tag">${z}<button onclick="removeZone('${u.uid}','${z}')" title="Verwijderen">×</button></span>`
    ).join('');

    const availableZones = KNOWN_ZONES.filter(z => !zones.includes(z));
    const zoneSelect = availableZones.length > 0
      ? `<div class="add-zone">
           <select id="zone-add-${u.uid}">
             ${availableZones.map(z=>`<option value="${z}">${z}</option>`).join('')}
           </select>
           <button onclick="addZone('${u.uid}')">+ Toevoegen</button>
         </div>`
      : '<span style="font-size:12px;color:#94a3b8">Alle gebieden toegewezen</span>';

    return `
      <tr>
        <td>
          <strong>${u.displayName || '—'}</strong><br>
          <span style="font-size:12px;color:#64748b">${u.email || u.uid}</span>
        </td>
        <td>
          <select onchange="setRole('${u.uid}', this.value)">
            <option value="pending"  ${(u.role||'pending')==='pending'  ?'selected':''}>Pending</option>
            <option value="volunteer"${u.role==='volunteer'?'selected':''}>Vrijwilliger</option>
            <option value="manager"  ${u.role==='manager'  ?'selected':''}>Beheerder</option>
            <option value="admin"    ${u.role==='admin'    ?'selected':''}>Admin</option>
          </select>
        </td>
        <td>
          <div class="zones-cell">
            ${zoneTags}
            ${zoneSelect}
          </div>
        </td>
      </tr>`;
  }).join('');

  document.getElementById('users-table').innerHTML = `
    <table>
      <thead><tr><th>Gebruiker</th><th>Rol</th><th>Gebieden</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── Acties ────────────────────────────────────────────────────────
window.setRole = async (uid, role) => {
  await setDoc(doc(db, 'roles', uid), { role }, { merge: true });
};

window.addZone = async (uid) => {
  const sel = document.getElementById(`zone-add-${uid}`);
  if (!sel) return;
  const zone = sel.value;
  const snap = await getDoc(doc(db, 'roles', uid));
  const zones = Array.isArray(snap.data()?.zones) ? snap.data().zones : [];
  if (!zones.includes(zone)) {
    await setDoc(doc(db, 'roles', uid), { zones: [...zones, zone] }, { merge: true });
  }
};

window.removeZone = async (uid, zone) => {
  const snap = await getDoc(doc(db, 'roles', uid));
  const zones = (snap.data()?.zones || []).filter(z => z !== zone);
  await setDoc(doc(db, 'roles', uid), { zones }, { merge: true });
};
