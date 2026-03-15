// admin.js — Fix 122
// Wijziging t.o.v. Fix 26:
// - Welkomst-email via EmailJS (client-side) i.p.v. Firebase Trigger Email extensie
// - sendWelcomeEmail() gebruikt emailjs.send() via CDN
// - Geen Firestore 'mail' collectie meer nodig
// - EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY bovenaan instellen

import { auth } from './firebase.js';
import { getFirestore, collection, doc, setDoc, onSnapshot, query, where, getDoc, deleteDoc, getDocs }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { app } from './firebase.js';

const db        = getFirestore(app);

// Helper: naam veilig maken voor gebruik in onclick attribuut
function _esc(s) { return String(s||'').replace(/'/g, '&#39;'); }
const functions = getFunctions(app, 'europe-west4');

// ======================= EmailJS configuratie =======================
// BELANGRIJK: vul hier je eigen keys in vanuit emailjs.com
const EMAILJS_SERVICE_ID  = 'service_am7yhzo';
const EMAILJS_TEMPLATE_ID = 'template_8jyfjkf';
const EMAILJS_PUBLIC_KEY  = 'grly1relpuAh_73z7';

// Zones — worden dynamisch geladen uit Firestore config/zones
// Fallback waarden voor als Firestore nog niet bereikbaar is
let KNOWN_ZONES = ['Zeist','Bilthoven','Driebergen','Utrecht'];
let ZONE_BOUNDS = {
  'Zeist':      [52.05, 5.17, 52.14, 5.33],
  'Bilthoven':  [52.09, 5.14, 52.18, 5.26],
  'Driebergen': [52.02, 5.24, 52.09, 5.35],
  'Utrecht':    [52.04, 5.03, 52.15, 5.18],
};
let ZONE_WKT = {
  'Zeist':      'POLYGON((5.17 52.05,5.33 52.05,5.33 52.14,5.17 52.14,5.17 52.05))',
  'Bilthoven':  'POLYGON((5.14 52.09,5.26 52.09,5.26 52.18,5.14 52.18,5.14 52.09))',
  'Driebergen': 'POLYGON((5.24 52.02,5.35 52.02,5.35 52.09,5.24 52.09,5.24 52.02))',
  'Utrecht':    'POLYGON((5.03 52.04,5.18 52.04,5.18 52.15,5.03 52.15,5.03 52.04))',
};

async function _loadZonesAdmin() {
  try {
    const snap = await getDoc(doc(db, 'config', 'zones'));
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.zones) && data.zones.length) {
        KNOWN_ZONES = data.zones.map(z => z.key);
        ZONE_BOUNDS = {};
        ZONE_WKT = {};
        data.zones.forEach(z => {
          if (z.bbox) ZONE_BOUNDS[z.key] = z.bbox;
          if (z.wkt)  ZONE_WKT[z.key]   = z.wkt;
        });
      }
    }
  } catch(e) { console.warn('[admin] zones fallback:', e.message); }
}

const ACCEPTED_ROLES = ['volunteer', 'manager', 'admin'];

let _unsubUsers = null;
let _adminUid   = null;

// ======================= Overlay =======================
function createOverlay() {
  if (document.getElementById('admin-overlay')) return;

  // Injecteer CSS zodat overlay altijd werkt ongeacht app.css
  if (!document.getElementById('admin-css')) {
    const style = document.createElement('style');
    style.id = 'admin-css';
    style.textContent = `
      #admin-overlay {
        display: none;
        position: fixed; inset: 0; z-index: 9000;
        background: rgba(0,0,0,.5);
        align-items: flex-start; justify-content: center;
        padding-top: 60px;
      }
      #admin-overlay.open { display: flex; }
      #admin-panel {
        background: #fff; border-radius: 10px; width: 90%; max-width: 860px;
        max-height: 80vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,.25);
      }
      #admin-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 18px; border-bottom: 1px solid #e2e8f0; font-size: 16px;
      }
      #admin-body { overflow-y: auto; flex: 1; padding: 8px; }
      #admin-footer { padding: 10px 18px; color: #64748b; font-size: 12px; border-top: 1px solid #e2e8f0; margin: 0; }
      #admin-close { background: none; border: 0; font-size: 18px; cursor: pointer; color: #64748b; }
      .adm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .adm-table th { text-align: left; padding: 8px 10px; background: #f8fafc; border-bottom: 2px solid #e2e8f0; }
      .adm-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
      .adm-row-pending { background: #fffbeb; }
      .adm-muted { color: #94a3b8; font-size: 12px; }
      .adm-sel { padding: 4px 6px; border: 1px solid #cbd5e1; border-radius: 5px; font-size: 12px; }
      .adm-tag { display: inline-flex; align-items: center; gap: 3px; background: #e0f2fe; color: #0369a1; border-radius: 4px; padding: 2px 6px; font-size: 12px; margin: 2px; }
      .adm-tag-rm { background: none; border: 0; cursor: pointer; color: #64748b; font-size: 14px; line-height: 1; padding: 0 2px; }
      .adm-zone-add { display: flex; gap: 4px; margin-top: 4px; }
      .adm-zone-add select { font-size: 12px; padding: 3px; border: 1px solid #cbd5e1; border-radius: 4px; }
      .adm-zone-add button { font-size: 12px; padding: 3px 8px; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: #f8fafc; }
      .adm-btn-accept { background: #0aa879; color: #fff; border: 0; border-radius: 5px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
      .adm-btn-reject { background: #fee2e2; color: #991b1b; border: 0; border-radius: 5px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
      .adm-btn-delete { background: #fee2e2; color: #991b1b; border: 0; border-radius: 5px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
      .adm-btn-icon { background: none; border: 0; cursor: pointer; font-size: 14px; padding: 2px; }
      .adm-tabs { display: flex; gap: 0; border-bottom: 2px solid #e2e8f0; margin-bottom: 0; flex-wrap: wrap; }
      .adm-tab { padding: 8px 12px; border: 0; background: none; cursor: pointer; font-size: 12px; font-weight: 600; color: #64748b; border-bottom: 3px solid transparent; margin-bottom: -2px; white-space: nowrap; }
      .adm-tab.active { color: #0aa879; border-bottom-color: #0aa879; }
      .adm-sync-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .adm-sync-input { flex: 1; padding: 7px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; font-family: monospace; }
      .adm-sync-btn { padding: 7px 16px; background: #0aa879; color: #fff; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; white-space: nowrap; }
      .adm-sync-btn:disabled { background: #94a3b8; cursor: not-allowed; }
      .adm-sync-log { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; font-size: 12px; max-height: 300px; overflow-y: auto; line-height: 1.6; }
      .adm-sync-obs { border-bottom: 1px solid #f1f5f9; padding: 6px 0; }
      .adm-sync-obs:last-child { border-bottom: 0; }
    `;
    document.head.appendChild(style);
  }

  const el = document.createElement('div');
  el.id = 'admin-overlay';
  el.innerHTML = `
    <div id="admin-panel">
      <div id="admin-header">
        <strong>⚙️ Beheer</strong>
        <button id="admin-close" title="Sluiten">✕</button>
      </div>
      <div class="adm-tabs" id="adm-tabs-bar">
        <button class="adm-tab active" data-tab="overzicht">📊 Overzicht</button>
        <button class="adm-tab adm-tab-admin" data-tab="users">👥 Gebruikers</button>
        <button class="adm-tab adm-tab-admin" data-tab="gebieden">📍 Gebieden</button>
        <button class="adm-tab adm-tab-admin" data-tab="sync">📄 CSV Import</button>
        <button class="adm-tab adm-tab-admin" data-tab="gbif">🌍 GBIF Sync</button>
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
  // Tab wisselen
  el.querySelectorAll('.adm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.adm-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Footer alleen zichtbaar bij Gebruikers-tab (Fix 104)
      const footer = document.getElementById('admin-footer');
      if (footer) footer.style.display = btn.dataset.tab === 'users' ? '' : 'none';
      if (btn.dataset.tab === 'users') startListening();
      else if (btn.dataset.tab === 'sync') openSyncTab();
      else if (btn.dataset.tab === 'gbif') openGbifTab();
      else if (btn.dataset.tab === 'gebieden') openGebiedenTab();
      else if (btn.dataset.tab === 'overzicht') openOverzichtTab();
    });
  });
}

function setAdminBody(html) {
  const body = document.getElementById('admin-body');
  if (body) body.innerHTML = html;
}

export async function openAdminOverlay(callerRole) {
  const uid = auth.currentUser?.uid;
  if (!uid) { alert('Niet ingelogd.'); return; }
  _adminUid = uid;

  await _loadZonesAdmin(); // zones altijd vers laden bij openen beheer
  createOverlay();
  document.getElementById('admin-overlay').classList.add('open');

  // Role bepalen: gebruik meegegeven rol (sneller), of haal op uit Firestore
  let myRole = callerRole;
  if (!myRole) {
    try {
      const mySnap = await getDoc(doc(db, 'roles', uid));
      myRole = mySnap.data()?.role;
    } catch (e) {
      setAdminBody(`<p style="color:red;padding:12px">Fout bij rolcheck: ${e.code} — ${e.message}</p>`);
      return;
    }
  }

  const isAdmin = myRole === 'admin';

  // Admin-only tabs tonen/verbergen
  document.querySelectorAll('.adm-tab-admin').forEach(tab => {
    tab.style.display = isAdmin ? '' : 'none';
  });

  if (isAdmin) {
    // Admin: standaard op Gebruikers tab
    document.querySelectorAll('.adm-tab').forEach(b => b.classList.remove('active'));
    const usersTab = document.querySelector('.adm-tab[data-tab="users"]');
    if (usersTab) usersTab.classList.add('active');
    const footer = document.getElementById('admin-footer');
    if (footer) footer.style.display = '';
    startListening();
  } else if (myRole === 'manager' || myRole === 'volunteer') {
    // Manager/Vrijwilliger: alleen Overzicht tab, direct openen
    document.querySelectorAll('.adm-tab').forEach(b => b.classList.remove('active'));
    const overzichtTab = document.querySelector('.adm-tab[data-tab="overzicht"]');
    if (overzichtTab) overzichtTab.classList.add('active');
    const footer = document.getElementById('admin-footer');
    if (footer) footer.style.display = 'none'; // verborgen bij overzicht
    openOverzichtTab();
  } else {
    setAdminBody(`<p style="color:red;padding:12px">Geen toegang. Jouw rol is: "${myRole}"</p>`);
  }
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
          <button class="adm-btn-icon" title="Naam bewerken" onclick="adminEditName('${u.uid}','${_esc(u.displayName)}')">✏️</button>
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
            <button class="adm-btn-accept" onclick="adminOpenAcceptDialog('${u.uid}','${_esc(u.email)}','${_esc(u.displayName)}')">✓ Accepteren</button>
            <button class="adm-btn-reject" onclick="adminRejectUser('${u.uid}','${_esc(u.displayName||u.email)}')">✕ Weigeren</button>
          </div>
        </td>`;
    } else {
      const deleteBtn = isAccepted && !isSelf
        ? `<button class="adm-btn-delete" onclick="adminDeleteUser('${u.uid}','${_esc(u.displayName||u.email)}')">🗑️ Verwijderen</button>`
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
             ${available.map(z=>'<option value="' + z + '">' + z.replace('Hoornaar_','') + '</option>').join('')}
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
window.adminOpenAcceptDialog = async (uid, email, currentName) => {
  document.getElementById('adm-accept-dialog')?.remove();

  // Laad huidige beheerders per zone voor hint
  let managerMap = {};
  try {
    const allRoles = await getDocs(collection(db, 'roles'));
    allRoles.forEach(d => {
      const data = d.data();
      if (data.role === 'manager' && Array.isArray(data.zones)) {
        data.zones.forEach(z => { if (!managerMap[z]) managerMap[z] = data.displayName || data.email || '?'; });
      }
    });
  } catch{}

  const zonesOptions = KNOWN_ZONES.map(z => {
    const mgr = managerMap[z];
    const hint = mgr ? `<span style="font-size:11px;color:#94a3b8;margin-left:4px">(${mgr})</span>` : '';
    return `<label style="display:block;margin:3px 0">
      <input type="checkbox" name="adz" value="${z}"> ${z.replace('Hoornaar_','')}${hint}
     </label>`;
  }).join('');

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

// ======================= Waarneming.nl CSV Import =======================
// Zones met hun bounding boxes [minLat, minLng, maxLat, maxLng]
// ZONE_BOUNDS en ZONE_WKT worden nu dynamisch geladen via _loadZonesAdmin()

function openSyncTab() {
  const lastSync = localStorage.getItem('wn_last_sync') || '';
  setAdminBody(
    '<div style="padding:16px;max-width:620px">' +
    '<h3 style="margin:0 0 4px;font-size:15px">&#x1F504; Import vanuit waarneming.nl</h3>' +
    '<p style="color:#64748b;font-size:13px;margin:0 0 16px;line-height:1.6">' +
    'Exporteer de waarnemingen van <strong>Aziatische hoornaar</strong> als CSV vanuit waarneming.nl ' +
    'en upload het bestand hier. Duplicaten worden automatisch overgeslagen.' +
    '</p>' +
    '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;color:#166534">' +
    '<strong>Hoe exporteer je vanuit waarneming.nl?</strong><br>' +
    '1. Ga naar waarneming.nl &rarr; Verkennen &rarr; Soort zoeken: "Aziatische hoornaar"<br>' +
    '2. Filter op jouw gemeente/regio en gewenste periode<br>' +
    '3. Klik op <strong>Exporteren &rarr; CSV</strong> (rechts bovenaan de lijst)<br>' +
    '4. Upload het gedownloade bestand hieronder' +
    '</div>' +
    '<div class="adm-sync-row" style="flex-direction:column;align-items:flex-start;gap:10px">' +
    '<label style="font-size:12px;font-weight:600;color:#475569">CSV bestand selecteren</label>' +
    '<div style="display:flex;gap:8px;align-items:center;width:100%">' +
    '<input type="file" id="wn-csv-file" accept=".csv,.txt" style="flex:1;padding:6px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px"/>' +
    '<button class="adm-sync-btn" id="wn-import-btn">&#9654; Importeren</button>' +
    '</div>' +
    (lastSync ? '<p style="font-size:11px;color:#94a3b8;margin:0">Laatste import: ' + new Date(lastSync).toLocaleString('nl-NL') + '</p>' : '') +
    '</div>' +
    '<div id="wn-log" class="adm-sync-log" style="min-height:80px;margin-top:14px">' +
    '<span style="color:#94a3b8">Selecteer een CSV bestand en klik op Importeren.</span>' +
    '</div>' +
    '</div>'
  );
  document.getElementById('wn-import-btn')?.addEventListener('click', () => {
    const file = document.getElementById('wn-csv-file')?.files[0];
    if (!file) { alert('Selecteer eerst een CSV bestand.'); return; }
    runCsvImport(file);
  });
}

function logSync(msg, color) {
  color = color || '#334155';
  const log = document.getElementById('wn-log');
  if (!log) return;
  if (log.querySelector('span')) log.innerHTML = '';
  const line = document.createElement('div');
  line.style.cssText = 'padding:2px 0;color:' + color;
  line.textContent = new Date().toLocaleTimeString('nl-NL') + ' \u2014 ' + msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function splitCsvLine(line, sep) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === sep && !inQ) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function parseWaarnemingCsv(text) {
  const sep = (text.indexOf(';') > -1 && text.indexOf(';') < text.indexOf('\n')) ? ';' : ',';
  const lines = text.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(sep).map(function(h){ return h.replace(/["\r]/g,'').toLowerCase().trim(); });

  function col(name) {
    const aliases = {
      id:       ['id','observation id','waarneming id','waarnemingid'],
      lat:      ['lat','latitude','breedtegraad','y'],
      lng:      ['lon','lng','longitude','lengtegraad','x'],
      date:     ['datum','date','waarneming datum','observatiedatum'],
      observer: ['waarnemer','observer','gebruiker','user'],
      number:   ['aantal','number','count'],
      location: ['locatie','location','plaatsnaam','locality','location name'],
      notes:    ['opmerking','notes','remarks','notitie','opmerkingen'],
      status:   ['status','validatiestatus','validation status'],
    };
    const list = aliases[name] || [name];
    for (let a = 0; a < list.length; a++) {
      const idx = headers.indexOf(list[a]);
      if (idx > -1) return idx;
    }
    return -1;
  }

  const idIdx  = col('id'),  latIdx = col('lat'), lngIdx = col('lng');
  const dateIdx = col('date'), obsIdx = col('observer'), numIdx = col('number');
  const locIdx = col('location'), notesIdx = col('notes'), statusIdx = col('status');

  if (latIdx === -1 || lngIdx === -1) return null;

  const obs = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i], sep);
    function get(idx) { return (idx > -1 && idx < parts.length) ? parts[idx].replace(/^"|"$/g,'').trim() : ''; }

    const lat = parseFloat(get(latIdx).replace(',','.'));
    const lng = parseFloat(get(lngIdx).replace(',','.'));
    if (isNaN(lat) || isNaN(lng)) continue;

    let date = get(dateIdx);
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) date = date.split('-').reverse().join('-');
    else if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) { const p = date.split('/'); date = p[2]+'-'+p[1]+'-'+p[0]; }

    obs.push({
      id:       get(idIdx) || ('csv_' + i),
      lat, lng,
      date:     date || new Date().toISOString().slice(0,10),
      by:       get(obsIdx) || 'waarneming.nl',
      aantal:   parseInt(get(numIdx)) || 1,
      location: get(locIdx),
      notes:    get(notesIdx),
      status:   get(statusIdx),
    });
  }
  return obs;
}

async function runCsvImport(file) {
  const btn = document.getElementById('wn-import-btn');
  btn.disabled = true; btn.textContent = '\u23F3 Bezig\u2026';
  logSync('CSV lezen: ' + file.name);

  const text = await file.text();
  const obs = parseWaarnemingCsv(text);

  if (!obs) {
    logSync('Fout: geen lat/lon kolommen gevonden. Controleer het bestand.', '#ef4444');
    btn.disabled = false; btn.textContent = '\u25BA Importeren'; return;
  }
  if (obs.length === 0) {
    logSync('Geen geldige rijen gevonden in CSV.', '#f59e0b');
    btn.disabled = false; btn.textContent = '\u25BA Importeren'; return;
  }
  logSync(obs.length + ' rijen gelezen.');

  const year = new Date().getFullYear().toString();
  let imported = 0, duplicates = 0, outOfZone = 0;

  for (let oi = 0; oi < obs.length; oi++) {
    const o = obs[oi];
    let zone = null;
    const zoneKeys = Object.keys(ZONE_BOUNDS);
    for (let zi = 0; zi < zoneKeys.length; zi++) {
      const z = zoneKeys[zi]; const bbox = ZONE_BOUNDS[z];
      if (o.lat >= bbox[0] && o.lat <= bbox[2] && o.lng >= bbox[1] && o.lng <= bbox[3]) { zone = z; break; }
    }
    if (!zone) { outOfZone++; continue; }

    const externalId = 'wn_' + o.id;
    const base = 'maps/' + year + '/' + zone + '/data';
    const existing = await getDocs(query(collection(db, base, 'markers'), where('externalId', '==', externalId)));
    if (!existing.empty) { duplicates++; continue; }

    const noteParts = [];
    if (o.notes) noteParts.push(o.notes);
    if (o.location) noteParts.push('\uD83D\uDCCD ' + o.location);
    if (o.status) noteParts.push('\u2714 ' + o.status);
    noteParts.push('Bron: waarneming.nl');

    await setDoc(doc(db, base, 'markers', externalId), {
      id: externalId, type: 'hoornaar',
      lat: o.lat, lng: o.lng, date: o.date,
      by: o.by, aantal: o.aantal,
      note: noteParts.join('\n'),
      externalId, source: 'waarneming.nl',
    });
    imported++;
    logSync('\u2705 ' + o.date + ' | ' + o.by + ' | ' + zone + (o.location ? ' | ' + o.location : ''), '#0aa879');
  }

  localStorage.setItem('wn_last_sync', new Date().toISOString());
  logSync('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', '#e2e8f0');
  logSync('Klaar! ' + imported + ' geïmporteerd, ' + duplicates + ' duplicaten, ' + outOfZone + ' buiten gebieden.', imported > 0 ? '#0aa879' : '#f59e0b');
  btn.disabled = false; btn.textContent = '\u25BA Importeren';
}

// ======================= GBIF Synchronisatie =======================
// GBIF taxonKey voor Vespa velutina (Aziatische hoornaar)
const GBIF_TAXON_KEY = 1311477;
const GBIF_API = 'https://api.gbif.org/v1/occurrence/search';

function openGebiedenTab() {
  const body = document.getElementById('admin-body');
  if (!body) return;
  _renderGebiedenTab(body);
}

async function _renderGebiedenTab(body) {
  body.innerHTML = '<div style="padding:12px;color:#94a3b8;font-size:13px">Gebieden laden…</div>';
  // Zones altijd vers laden
  await _loadZonesAdmin();

  // Huidige zones uit Firestore (volledig object met alle velden)
  let allZones = [];
  try {
    const snap = await getDoc(doc(db, 'config', 'zones'));
    if (snap.exists() && Array.isArray(snap.data().zones)) {
      allZones = snap.data().zones;
    }
  } catch(e) {}

  // Als nog leeg, initialiseer met defaults
  if (!allZones.length) {
    allZones = [
      { key:'Zeist',      label:'Zeist',      lat:52.0893, lon:5.2425, zoom:13, bbox:[52.05,5.17,52.14,5.33] },
      { key:'Bilthoven',  label:'Bilthoven',  lat:52.1267, lon:5.1986, zoom:13, bbox:[52.09,5.14,52.18,5.26] },
      { key:'Driebergen', label:'Driebergen', lat:52.0561, lon:5.2867, zoom:13, bbox:[52.02,5.24,52.09,5.35] },
      { key:'Utrecht',    label:'Utrecht',    lat:52.0907, lon:5.1214, zoom:13, bbox:[52.04,5.03,52.15,5.18] },
    ];
  }

  const rows = allZones.map((z,i) => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:6px 8px;font-weight:600;color:#1e293b">${z.label}</td>
      <td style="padding:6px 8px;color:#64748b;font-size:12px">${z.key}</td>
      <td style="padding:6px 8px;color:#64748b;font-size:12px">${z.lat?.toFixed(4)}, ${z.lon?.toFixed(4)}</td>
      <td style="padding:6px 8px">
        <button onclick="window._editZone(${i})" style="padding:3px 8px;font-size:12px;border:1px solid #cbd5e1;border-radius:4px;cursor:pointer;background:#fff">✏️</button>
        <button onclick="window._deleteZone('${z.key}')" style="padding:3px 8px;font-size:12px;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;background:#fff;color:#dc2626">🗑️</button>
      </td>
    </tr>`).join('');

  body.innerHTML = `
    <div style="padding:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:14px;color:#1e293b">📍 Gebieden beheren</h3>
        <button id="zone-add-btn" style="padding:6px 14px;border-radius:6px;border:none;background:#0aa879;color:#fff;font-size:13px;font-weight:600;cursor:pointer">+ Nieuw gebied</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#f8fafc;color:#64748b;font-size:11px">
          <th style="text-align:left;padding:6px 8px">Naam</th>
          <th style="text-align:left;padding:6px 8px">Sleutel</th>
          <th style="text-align:left;padding:6px 8px">Centrum</th>
          <th style="padding:6px 8px"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:11px;color:#94a3b8;margin-top:12px">
        Gebieden worden direct beschikbaar na opslaan. Gebruikers moeten de app herladen.
      </p>
    </div>`;

  document.getElementById('zone-add-btn')?.addEventListener('click', () => window._editZone(-1));

  // Edit/delete handlers
  window._zoneData = allZones;

  window._deleteZone = async (key) => {
    if (!confirm(`Gebied "${key}" verwijderen?\n\nDe kaartdata blijft bewaard maar het gebied is niet meer selecteerbaar.`)) return;
    const updated = allZones.filter(z => z.key !== key);
    await setDoc(doc(db, 'config', 'zones'), { zones: updated });
    _renderGebiedenTab(body);
  };

  window._editZone = (idx) => {
    const zone = idx >= 0 ? allZones[idx] : { key:'', label:'', lat:52.09, lon:5.12, zoom:13, bbox:null };
    const isNew = idx < 0;
    _showZoneEditModal(zone, isNew, async (updated) => {
      let newList;
      if (isNew) {
        // Check duplicate key
        if (allZones.some(z => z.key === updated.key)) {
          alert(`Sleutel "${updated.key}" bestaat al.`); return;
        }
        newList = [...allZones, updated];
      } else {
        newList = allZones.map((z,i) => i === idx ? updated : z);
      }
      await setDoc(doc(db, 'config', 'zones'), { zones: newList });
      await _loadZonesAdmin();
      _renderGebiedenTab(body);
    });
  };
}

function _showZoneEditModal(zone, isNew, onSave) {
  const existing = document.getElementById('zone-edit-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'zone-edit-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)';

  const dfl = zone.lat || 52.09;
  const dfo = zone.lon || 5.12;

  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:20px 24px;width:380px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,.25);max-height:92vh;overflow-y:auto">
      <h3 style="margin:0 0 16px;font-size:15px">${isNew ? '➕ Nieuw gebied' : '✏️ Gebied bewerken'}</h3>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        <label>Naam (weergave)
          <input id="ze-label" value="${zone.label||''}" style="width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:5px;margin-top:3px;font-size:13px;box-sizing:border-box"/>
        </label>
        <label>Sleutel (interne ID, geen spaties)
          <input id="ze-key" value="${zone.key||''}" ${isNew?'':'readonly style="opacity:0.6"'} style="width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:5px;margin-top:3px;font-size:13px;box-sizing:border-box" placeholder="bijv. Doorn"/>
        </label>

        <!-- Kaart-picker voor centrumcoördinaat -->
        <div>
          <div style="font-size:12px;color:#475569;margin-bottom:4px;font-weight:600">📍 Klik op de kaart om het centrum te kiezen</div>
          <div id="ze-picker-map" style="height:200px;border-radius:8px;border:1px solid #cbd5e1;overflow:hidden;cursor:crosshair"></div>
          <div id="ze-picker-hint" style="font-size:11px;color:#94a3b8;margin-top:3px">Klik op een locatie — coördinaten worden automatisch ingevuld</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;align-items:end">
          <label>Lat centrum<input id="ze-lat" type="number" step="0.0001" value="${dfl}" style="width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:5px;margin-top:3px;font-size:13px;box-sizing:border-box"/></label>
          <label>Lon centrum<input id="ze-lon" type="number" step="0.0001" value="${dfo}" style="width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:5px;margin-top:3px;font-size:13px;box-sizing:border-box"/></label>
          <button id="ze-lookup" style="padding:6px 8px;border-radius:5px;border:1px solid #0aa879;background:#f0fdf4;color:#0aa879;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap">🔍 Zoek bbox</button>
        </div>
        <label>Zoom niveau (11–15)
          <input id="ze-zoom" type="number" min="11" max="15" value="${zone.zoom||13}" style="width:80px;padding:6px;border:1px solid #cbd5e1;border-radius:5px;margin-top:3px;font-size:13px"/>
        </label>

        <!-- Bbox preview -->
        <div id="ze-map-preview" style="display:none;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0">
          <img id="ze-map-img" style="width:100%;display:block" alt="Kaartpreview"/>
          <div id="ze-map-label" style="font-size:11px;color:#64748b;padding:4px 8px;background:#f8fafc"></div>
        </div>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:12px;color:#475569">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <strong>Bounding box</strong>
            <span id="ze-bbox-src" style="font-size:11px;color:#94a3b8"></span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <label>Min lat<input id="ze-bmin-lat" type="number" step="0.001" value="${zone.bbox?zone.bbox[0]:(dfl-0.07).toFixed(3)}" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;box-sizing:border-box"/></label>
            <label>Min lon<input id="ze-bmin-lon" type="number" step="0.001" value="${zone.bbox?zone.bbox[1]:(dfo-0.1).toFixed(3)}" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;box-sizing:border-box"/></label>
            <label>Max lat<input id="ze-bmax-lat" type="number" step="0.001" value="${zone.bbox?zone.bbox[2]:(dfl+0.07).toFixed(3)}" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;box-sizing:border-box"/></label>
            <label>Max lon<input id="ze-bmax-lon" type="number" step="0.001" value="${zone.bbox?zone.bbox[3]:(dfo+0.1).toFixed(3)}" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;box-sizing:border-box"/></label>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="ze-cancel" style="flex:1;padding:8px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;font-size:13px">Annuleren</button>
        <button id="ze-save" style="flex:2;padding:8px;border-radius:6px;border:none;background:#0aa879;color:#fff;cursor:pointer;font-size:13px;font-weight:600">Opslaan</button>
      </div>
      <div id="ze-error" style="font-size:12px;color:#dc2626;margin-top:6px;min-height:16px"></div>
    </div>`;
  document.body.appendChild(modal);

  // Initialiseer Leaflet picker kaart
  let pickerMarker = null;
  const pickerMap = L.map('ze-picker-map', { zoomControl: true, attributionControl: false }).setView([dfl, dfo], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(pickerMap);

  // Toon bestaand centrum als marker
  if (zone.lat && zone.lon) {
    pickerMarker = L.marker([zone.lat, zone.lon]).addTo(pickerMap);
  }

  pickerMap.on('click', (e) => {
    const { lat, lng } = e.latlng;
    // Marker plaatsen of verplaatsen
    if (pickerMarker) pickerMarker.setLatLng([lat, lng]);
    else pickerMarker = L.marker([lat, lng]).addTo(pickerMap);
    // Velden invullen (4 decimalen)
    modal.querySelector('#ze-lat').value = lat.toFixed(5);
    modal.querySelector('#ze-lon').value = lng.toFixed(5);
    modal.querySelector('#ze-picker-hint').textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)} — klik op 🔍 Zoek bbox`;
    modal.querySelector('#ze-picker-hint').style.color = '#0aa879';
  });

  // Leaflet heeft invalidateSize nodig als de container net zichtbaar is
  setTimeout(() => pickerMap.invalidateSize(), 100);

  // Auto-fill sleutel vanuit naam
  if (isNew) {
    modal.querySelector('#ze-label').addEventListener('input', e => {
      const key = e.target.value.trim().replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
      modal.querySelector('#ze-key').value = key;
    });
  }

  // Tweede Leaflet kaart voor bbox visualisatie en aanpassing
  let bboxMap = null;
  let bboxRect = null;

  function _initBboxMap() {
    if (bboxMap) return; // al geïnitialiseerd
    const container = modal.querySelector('#ze-map-preview');
    container.style.display = 'block';
    container.innerHTML = `<div id="ze-bbox-map" style="height:200px;border-radius:8px 8px 0 0"></div>
      <div style="font-size:11px;color:#64748b;padding:5px 8px;background:#f8fafc;display:flex;justify-content:space-between">
        <span id="ze-bbox-coords">–</span>
        <span style="color:#94a3b8">Sleep hoekpunten om de box aan te passen</span>
      </div>`;
    bboxMap = L.map('ze-bbox-map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(bboxMap);
    setTimeout(() => bboxMap.invalidateSize(), 100);
  }

  function _updateBboxMap() {
    const minLat = parseFloat(modal.querySelector('#ze-bmin-lat').value);
    const minLon = parseFloat(modal.querySelector('#ze-bmin-lon').value);
    const maxLat = parseFloat(modal.querySelector('#ze-bmax-lat').value);
    const maxLon = parseFloat(modal.querySelector('#ze-bmax-lon').value);
    if (isNaN(minLat)||isNaN(minLon)||isNaN(maxLat)||isNaN(maxLon)) return;

    _initBboxMap();

    // Verwijder bestaande rechthoek en hoekmarkers
    if (bboxRect) { bboxMap.removeLayer(bboxRect); bboxRect = null; }
    if (bboxMap._cornerMarkers) { bboxMap._cornerMarkers.forEach(m => bboxMap.removeLayer(m)); }
    bboxMap._cornerMarkers = [];

    // Teken rechthoek
    bboxRect = L.rectangle([[minLat, minLon],[maxLat, maxLon]], {
      color: '#0aa879', weight: 2, fillOpacity: 0.15
    }).addTo(bboxMap);
    bboxMap.fitBounds([[minLat, minLon],[maxLat, maxLon]], { padding: [20,20] });

    // Label bijwerken
    const lbl = modal.querySelector('#ze-bbox-coords');
    if (lbl) lbl.textContent = `${minLat.toFixed(3)},${minLon.toFixed(3)} → ${maxLat.toFixed(3)},${maxLon.toFixed(3)}`;

    // Hoekmarkers toevoegen voor aanpassen
    const corners = [
      { lat: minLat, lon: minLon, updateMinLat: true,  updateMinLon: true  },
      { lat: maxLat, lon: minLon, updateMinLat: false, updateMinLon: true  },
      { lat: maxLat, lon: maxLon, updateMinLat: false, updateMinLon: false },
      { lat: minLat, lon: maxLon, updateMinLat: true,  updateMinLon: false },
    ];
    const cornerIcon = L.divIcon({ html:'<div style="width:12px;height:12px;background:#0aa879;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>', iconSize:[12,12], iconAnchor:[6,6], className:'' });

    corners.forEach(c => {
      const m = L.marker([c.lat, c.lon], { icon: cornerIcon, draggable: true }).addTo(bboxMap);
      m.on('drag', e => {
        const { lat, lng } = e.latlng;
        if (c.updateMinLat) modal.querySelector('#ze-bmin-lat').value = lat.toFixed(4);
        else                modal.querySelector('#ze-bmax-lat').value = lat.toFixed(4);
        if (c.updateMinLon) modal.querySelector('#ze-bmin-lon').value = lng.toFixed(4);
        else                modal.querySelector('#ze-bmax-lon').value = lng.toFixed(4);
        // Rechthoek live updaten
        const nMinLat = parseFloat(modal.querySelector('#ze-bmin-lat').value);
        const nMinLon = parseFloat(modal.querySelector('#ze-bmin-lon').value);
        const nMaxLat = parseFloat(modal.querySelector('#ze-bmax-lat').value);
        const nMaxLon = parseFloat(modal.querySelector('#ze-bmax-lon').value);
        bboxRect?.setBounds([[nMinLat,nMinLon],[nMaxLat,nMaxLon]]);
        const lbl2 = modal.querySelector('#ze-bbox-coords');
        if (lbl2) lbl2.textContent = `${nMinLat.toFixed(3)},${nMinLon.toFixed(3)} → ${nMaxLat.toFixed(3)},${nMaxLon.toFixed(3)}`;
      });
      m.on('dragend', () => _updateBboxMap()); // herrender alle hoekmarkers
      bboxMap._cornerMarkers.push(m);
    });
  }

  // Bbox opzoeken via Nominatim bij lat/lon
  // Handmatige invoer lat/lon → marker op kaart bijwerken
  ['ze-lat','ze-lon'].forEach(id => {
    modal.querySelector('#'+id).addEventListener('change', () => {
      const lat = parseFloat(modal.querySelector('#ze-lat').value);
      const lon = parseFloat(modal.querySelector('#ze-lon').value);
      if (!isNaN(lat) && !isNaN(lon)) {
        if (pickerMarker) pickerMarker.setLatLng([lat, lon]);
        else pickerMarker = L.marker([lat, lon]).addTo(pickerMap);
        pickerMap.setView([lat, lon], pickerMap.getZoom());
      }
    });
  });

  modal.querySelector('#ze-lookup').addEventListener('click', async () => {
    const lat = parseFloat(modal.querySelector('#ze-lat').value);
    const lon = parseFloat(modal.querySelector('#ze-lon').value);
    const btn = modal.querySelector('#ze-lookup');
    const src = modal.querySelector('#ze-bbox-src');
    if (isNaN(lat)||isNaN(lon)) { modal.querySelector('#ze-error').textContent='Vul eerst een coördinaat in'; return; }
    btn.textContent = '⏳'; btn.disabled = true;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=12`, {headers:{'Accept-Language':'nl'}});
      const d = await r.json();
      const bb = d.boundingbox; // [minLat, maxLat, minLon, maxLon] — Nominatim volgorde!
      if (bb && bb.length === 4) {
        const minLat = parseFloat(bb[0]), maxLat = parseFloat(bb[1]);
        const minLon = parseFloat(bb[2]), maxLon = parseFloat(bb[3]);
        modal.querySelector('#ze-bmin-lat').value = minLat.toFixed(4);
        modal.querySelector('#ze-bmin-lon').value = minLon.toFixed(4);
        modal.querySelector('#ze-bmax-lat').value = maxLat.toFixed(4);
        modal.querySelector('#ze-bmax-lon').value = maxLon.toFixed(4);
        if (src) src.textContent = `📍 ${d.display_name?.split(',').slice(0,2).join(',')||'Nominatim'}`;
        _updateBboxMap();
      } else {
        modal.querySelector('#ze-error').textContent = 'Geen bbox gevonden voor deze coördinaat';
      }
    } catch(e) {
      modal.querySelector('#ze-error').textContent = 'Fout: ' + e.message;
    } finally {
      btn.textContent = '🔍 Zoek bbox'; btn.disabled = false;
    }
  });

  // Preview updaten bij handmatige bbox-aanpassing
  ['ze-bmin-lat','ze-bmin-lon','ze-bmax-lat','ze-bmax-lon'].forEach(id => {
    modal.querySelector('#'+id).addEventListener('change', _updatePreview);
  });

  // Direct preview tonen als bbox al ingevuld is
  if (zone.bbox) _updateBboxMap();

  modal.querySelector('#ze-cancel').onclick = () => { pickerMap.remove(); if(bboxMap) bboxMap.remove(); modal.remove(); };
  modal.querySelector('#ze-save').onclick = () => {
    const label = modal.querySelector('#ze-label').value.trim();
    const key   = modal.querySelector('#ze-key').value.trim();
    const lat   = parseFloat(modal.querySelector('#ze-lat').value);
    const lon   = parseFloat(modal.querySelector('#ze-lon').value);
    const zoom  = parseInt(modal.querySelector('#ze-zoom').value) || 13;
    const bMinLat = parseFloat(modal.querySelector('#ze-bmin-lat').value);
    const bMinLon = parseFloat(modal.querySelector('#ze-bmin-lon').value);
    const bMaxLat = parseFloat(modal.querySelector('#ze-bmax-lat').value);
    const bMaxLon = parseFloat(modal.querySelector('#ze-bmax-lon').value);
    const errEl = modal.querySelector('#ze-error');

    if (!label) { errEl.textContent = 'Naam is verplicht'; return; }
    if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) { errEl.textContent = 'Sleutel mag alleen letters, cijfers en _ bevatten'; return; }
    if (isNaN(lat) || isNaN(lon)) { errEl.textContent = 'Vul geldige coördinaten in'; return; }

    const bbox = [bMinLat, bMinLon, bMaxLat, bMaxLon];
    const wkt = `POLYGON((${bMinLon} ${bMinLat},${bMaxLon} ${bMinLat},${bMaxLon} ${bMaxLat},${bMinLon} ${bMaxLat},${bMinLon} ${bMinLat}))`;

    onSave({ key, label, lat, lon, zoom, bbox, wkt });
    pickerMap.remove(); if(bboxMap) bboxMap.remove(); modal.remove();
  };
}

// ZONE_WKT wordt dynamisch geladen via _loadZonesAdmin()

function openGbifTab() {
  const lastSync = localStorage.getItem('gbif_last_sync') || '';
  const defaultDate = lastSync
    ? lastSync.slice(0, 10)
    : new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  setAdminBody(
    '<div style="padding:16px;max-width:620px">' +
    '<h3 style="margin:0 0 4px;font-size:15px">&#x1F30D; GBIF Synchronisatie</h3>' +
    '<p style="color:#64748b;font-size:13px;margin:0 0 14px;line-height:1.6">' +
    'Haalt waarnemingen van <strong>Aziatische hoornaar</strong> (Vespa velutina) op via de ' +
    'gratis publieke GBIF API — geen account of token nodig.' +
    '</p>' +
    '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#1e40af">' +
    '&#x2139;&#xFE0F; GBIF ontvangt zijn data van waarneming.nl (observation.org) via automatische nachtelijke synchronisatie. ' +
    'Recente waarnemingen van vandaag zijn mogelijk nog niet beschikbaar.' +
    '</div>' +
    '<div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:14px;flex-wrap:wrap">' +
    '<div>' +
    '<label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px">Synchroniseren vanaf</label>' +
    '<input type="date" id="gbif-date" class="adm-sync-input" style="max-width:170px" value="' + defaultDate + '"/>' +
    '</div>' +
    '<button class="adm-sync-btn" id="gbif-sync-btn">&#9654; Synchroniseren</button>' +
    '<button id="gbif-clean-btn" style="padding:7px 12px;border-radius:6px;border:1px solid #fca5a5;background:#fff;color:#dc2626;font-size:13px;font-weight:600;cursor:pointer">🗑️ Alle GBIF verwijderen</button>' +
    '<button id="gbif-debug-btn" style="padding:7px 12px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;color:#475569;font-size:13px;cursor:pointer">🔍 Toon ruwe velden</button>' +
    '</div>' +
    (lastSync ? '<p style="font-size:11px;color:#94a3b8;margin:0 0 12px">Laatste sync: ' + new Date(lastSync).toLocaleString('nl-NL') + '</p>' : '') +
    '<div id="gbif-log" class="adm-sync-log" style="min-height:80px">' +
    '<span style="color:#94a3b8">Klik op Synchroniseren om GBIF te bevragen.</span>' +
    '</div>' +
    '</div>'
  );

  document.getElementById('gbif-sync-btn')?.addEventListener('click', runGbifSync);
  document.getElementById('gbif-clean-btn')?.addEventListener('click', runGbifCleanup);
  document.getElementById('gbif-debug-btn')?.addEventListener('click', runGbifDebug);
}

function logGbif(msg, color) {
  color = color || '#334155';
  const log = document.getElementById('gbif-log');
  if (!log) return;
  if (log.querySelector('span')) log.innerHTML = '';
  const line = document.createElement('div');
  line.style.cssText = 'padding:2px 0;color:' + color;
  line.textContent = new Date().toLocaleTimeString('nl-NL') + ' \u2014 ' + msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function runGbifDebug() {
  const log = document.getElementById('gbif-log');
  if(log) log.innerHTML = '<span style="color:#94a3b8">Eerste waarneming ophalen…</span>';
  try {
    const zone = Object.keys(ZONE_WKT)[0];
    const wkt = ZONE_WKT[zone];
    const url = GBIF_API + '?taxonKey=' + GBIF_TAXON_KEY +
      '&geometry=' + encodeURIComponent(wkt) +
      '&hasCoordinate=true&limit=1';
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await resp.json();
    const o = data.results?.[0];
    if(!o){ logGbif('Geen resultaten gevonden.', '#f59e0b'); return; }

    // Toon alle velden gesorteerd
    const relevant = {
      gbifID: o.gbifID,
      decimalLatitude: o.decimalLatitude,
      decimalLongitude: o.decimalLongitude,
      verbatimLatitude: o.verbatimLatitude,
      verbatimLongitude: o.verbatimLongitude,
      coordinateUncertaintyInMeters: o.coordinateUncertaintyInMeters,
      coordinatePrecision: o.coordinatePrecision,
      eventDate: o.eventDate,
      year: o.year, month: o.month, day: o.day,
      recordedBy: o.recordedBy,
      identifiedBy: o.identifiedBy,
      individualCount: o.individualCount,
      occurrenceRemarks: o.occurrenceRemarks,
      behavior: o.behavior,
      lifeStage: o.lifeStage,
      sex: o.sex,
      locality: o.locality,
      municipality: o.municipality,
      county: o.county,
      stateProvince: o.stateProvince,
      country: o.country,
      basisOfRecord: o.basisOfRecord,
      datasetName: o.datasetName,
      collectionCode: o.collectionCode,
      institutionCode: o.institutionCode,
      occurrenceID: o.occurrenceID,
      taxonMatchType: o.taxonMatchType,
      issues: o.issues,
      establishmentMeans: o.establishmentMeans,
    };

    // Toon in log als tabel
    if(log){
      let html = '<div style="font-size:11px;font-family:monospace">';
      html += `<div style="font-weight:700;margin-bottom:6px;color:#0f172a">GBIF occurrence #${o.gbifID} (${zone})</div>`;
      html += '<table style="border-collapse:collapse;width:100%">';
      for(const [k,v] of Object.entries(relevant)){
        const val = v == null ? '<span style="color:#cbd5e1">null</span>' :
          Array.isArray(v) ? v.join(', ') : String(v);
        const highlight = ['decimalLatitude','decimalLongitude','verbatimLatitude','verbatimLongitude','coordinateUncertaintyInMeters'].includes(k)
          ? 'background:#fef3c7' : '';
        html += `<tr style="${highlight}">
          <td style="padding:2px 6px;color:#64748b;white-space:nowrap">${k}</td>
          <td style="padding:2px 6px;color:#1e293b;word-break:break-all">${val}</td>
        </tr>`;
      }
      html += '</table></div>';
      log.innerHTML = html;
    }
  } catch(e) {
    logGbif('Fout: ' + e.message, '#ef4444');
  }
}

async function runGbifCleanup() {
  if (!confirm('Alle GBIF waarnemingen verwijderen uit alle jaren en zones?\nDit kan niet ongedaan worden gemaakt.')) return;
  const btn = document.getElementById('gbif-clean-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Bezig…'; }
  logGbif('Start verwijderen van alle GBIF markers…', '#f59e0b');

  let total = 0;
  try {
    // Loop door alle bekende zones en jaren (haal jaren dynamisch op)
    const zoneNames = Object.keys(ZONE_WKT);
    // Jaren: haal alle subcollecties op via maps/{year} — we proberen 2020-huidig jaar
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let y = 2020; y <= currentYear; y++) years.push(String(y));

    for (const year of years) {
      for (const zone of zoneNames) {
        const colRef = collection(db, 'maps', year, zone, 'data', 'markers');
        const snap = await getDocs(query(colRef, where('source', '==', 'GBIF')));
        if (snap.empty) continue;
        logGbif(`${year}/${zone}: ${snap.size} GBIF markers gevonden`, '#64748b');
        for (const d of snap.docs) {
          await deleteDoc(doc(db, 'maps', year, zone, 'data', 'markers', d.id));
          total++;
        }
      }
    }
    logGbif(`✅ Klaar — ${total} GBIF markers verwijderd.`, '#0aa879');
  } catch(e) {
    logGbif('Fout bij verwijderen: ' + e.message, '#ef4444');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🗑️ Alle GBIF verwijderen'; }
  }
}

async function runGbifSync() {
  const dateStr = document.getElementById('gbif-date')?.value;
  const btn     = document.getElementById('gbif-sync-btn');
  if (!dateStr) { alert('Stel een datum in.'); return; }

  btn.disabled = true;
  btn.textContent = '\u23F3 Bezig\u2026';
  logGbif('Start GBIF query voor Vespa velutina vanaf ' + dateStr + '\u2026');

  const year = new Date().getFullYear().toString();
  let totalImported = 0, totalDuplicates = 0, totalOutOfZone = 0;

  try {
    const zoneNames = Object.keys(ZONE_WKT);
    for (let zi = 0; zi < zoneNames.length; zi++) {
      const zone = zoneNames[zi];
      const wkt  = ZONE_WKT[zone];
      logGbif('Zone ' + zone + ' opvragen bij GBIF\u2026', '#64748b');

      let offset = 0, pageObs = [], endOfRecords = false;
      let pageNum = 0;

      while (!endOfRecords) {
        pageNum++;
        const url = GBIF_API +
          '?taxonKey=' + GBIF_TAXON_KEY +
          '&geometry=' + encodeURIComponent(wkt) +
          '&eventDate=' + dateStr + ',' + new Date().toISOString().slice(0,10) +
          '&hasCoordinate=true' +
          '&hasGeospatialIssue=false' +
          '&limit=300&offset=' + offset;

        const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) {
          logGbif('GBIF fout ' + resp.status + ' voor zone ' + zone, '#ef4444');
          break;
        }
        const data = await resp.json();
        const results = data.results || [];
        pageObs = pageObs.concat(results);
        endOfRecords = data.endOfRecords !== false ? true : (results.length < 300);
        offset += results.length;
        if (pageNum > 10) { logGbif('Max paginas bereikt voor ' + zone, '#f59e0b'); break; }
      }

      if (!pageObs.length) {
        logGbif(zone + ': geen waarnemingen gevonden', '#94a3b8');
        continue;
      }
      logGbif(zone + ': ' + pageObs.length + ' waarneming(en) ontvangen');

      for (let oi = 0; oi < pageObs.length; oi++) {
        const o = pageObs[oi];
        const rawLat = o.decimalLatitude;
        const rawLng = o.decimalLongitude;
        if (!rawLat || !rawLng) continue;

        // Gebruik verbatimLatitude/Longitude als die meer decimalen heeft dan decimalLatitude
        // GBIF rondt decimalLatitude soms af bij ingest; verbatim bevat de originele waarde van waarneming.nl
        function parseDeg(v) { if(v==null) return null; const n=parseFloat(String(v).replace(',','.')); return isNaN(n)?null:n; }
        function decimals(v) { return (String(v).split('.')[1]||'').length; }
        const verbLat = parseDeg(o.verbatimLatitude);
        const verbLng = parseDeg(o.verbatimLongitude);
        const useLat = (verbLat != null && decimals(verbLat) > decimals(rawLat)) ? verbLat : rawLat;
        const useLng = (verbLng != null && decimals(verbLng) > decimals(rawLng)) ? verbLng : rawLng;

        // Detecteer nog steeds afgeronde gridcoördinaten (≤2 decimalen = onnauwkeurig, ~1km+)
        const latDecimals = decimals(useLat);
        const lngDecimals = decimals(useLng);
        const isGridSnapped = latDecimals <= 2 || lngDecimals <= 2;
        // Jitter alleen als echt grid-snapped (verbatim had ook geen betere waarde)
        const jitter = () => (Math.random() - 0.5) * 0.004;
        const lat = isGridSnapped ? useLat + jitter() : useLat;
        const lng = isGridSnapped ? useLng + jitter() : useLng;

        const gbifId   = 'gbif_' + o.gbifID;

        // Datum opbouwen
        const date = o.eventDate
          ? o.eventDate.slice(0, 10)
          : (o.year
            ? o.year + '-' + String(o.month || 1).padStart(2, '0') + '-' + String(o.day || 1).padStart(2, '0')
            : new Date().toISOString().slice(0, 10));

        // Jaar uit datum halen voor Firestore pad — waarneming hoort onder het jaar van observatie
        const obsYear = date.slice(0, 4);
        const base    = 'maps/' + obsYear + '/' + zone + '/data';

        // Waarnemer — GBIF geeft soms meerdere namen gescheiden door |
        const observer = o.recordedBy || o.identifiedBy || o.institutionCode || 'GBIF';

        // Locatie opbouwen
        const locParts = [o.locality, o.municipality, o.county, o.stateProvince].filter(Boolean);
        const locName  = locParts.join(', ');

        const aantal = o.individualCount || 1;

        // Gedragsinfo
        const behavior    = o.behavior || '';
        const lifestage   = o.lifeStage || '';
        const sex         = o.sex && o.sex !== 'UNKNOWN' ? o.sex : '';
        const established = o.establishmentMeans || '';

        // Validatie
        const taxonMatch  = o.taxonMatchType || '';
        const issues      = (o.issues || []).join(', ');
        const basisOfRec  = o.basisOfRecord || '';

        // Opmerking voor notitieveld (zichtbaar in popup)
        const noteParts = [];
        if (o.occurrenceRemarks) noteParts.push(o.occurrenceRemarks);
        if (locName) noteParts.push('\uD83D\uDCCD ' + locName);

        // Bepaal marker type: nest of hoornaar (imago)
        const remarksLower = (o.occurrenceRemarks || '').toLowerCase();
        const behaviorLower = behavior.toLowerCase();
        const isNest = remarksLower.includes('nest') || behaviorLower.includes('nest')
          || lifestage === 'WORKER' && remarksLower.includes('nest')
          || (o.occurrenceRemarks || '').toLowerCase().includes('nid')   // Frans
          || (o.occurrenceRemarks || '').toLowerCase().includes('colony');
        const markerType = isNest ? 'nest' : 'hoornaar';

        // Duplicaat check
        const existing = await getDocs(query(collection(db, base, 'markers'), where('externalId', '==', gbifId)));
        if (!existing.empty) { totalDuplicates++; continue; }

        await setDoc(doc(db, base, 'markers', gbifId), {
          id: gbifId, type: markerType,
          lat, lng, date,
          by: observer,
          aantal,
          note: noteParts.join('\n'),
          externalId: gbifId,
          source: 'GBIF',
          // Extra GBIF metadata — zichtbaar in detailweergave
          gbifKey:       String(o.gbifID || ''),
          gbifDataset:   o.datasetName || o.collectionCode || '',
          gbifLocality:  locName,
          gbifBehavior:  behavior,
          gbifLifestage: lifestage,
          gbifSex:       sex,
          gbifEstablishment: established,
          gbifBasis:     basisOfRec,
          gbifIssues:    issues,
          gbifUrl:       o.occurrenceID || ('https://www.gbif.org/occurrence/' + o.gbifID),
          gbifCoordPrec: o.coordinatePrecision != null ? String(o.coordinatePrecision) : '',
          gbifCoordUncertainty: o.coordinateUncertaintyInMeters != null ? String(o.coordinateUncertaintyInMeters) : '',
          gbifCoordJittered: isGridSnapped,
          gbifCountry:   o.country || '',
        });
        totalImported++;
        const coordNote = isGridSnapped
          ? ` ⚠️ grid±${o.coordinateUncertaintyInMeters||'?'}m (gespreide coördinaat)`
          : (verbLat && decimals(verbLat) > decimals(rawLat) ? ' 📍 verbatim coördinaat' : '');
        logGbif('\u2705 ' + date + ' | ' + (markerType==='nest'?'🪹 Nest':'🐝 Imago') + ' | ' + observer + ' | ' + zone + (locName ? ' | ' + locName : '') + coordNote, '#0aa879');
      }
    }

    localStorage.setItem('gbif_last_sync', new Date().toISOString());
    logGbif('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', '#e2e8f0');
    logGbif(
      'Klaar! ' + totalImported + ' ge\xEFmporteerd, ' +
      totalDuplicates + ' duplicaten overgeslagen.',
      totalImported > 0 ? '#0aa879' : '#f59e0b'
    );

  } catch (e) {
    logGbif('Fout: ' + e.message, '#ef4444');
    console.error('[gbif]', e);
  } finally {
    btn.disabled = false;
    btn.textContent = '\u25BA Synchroniseren';
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
    alert('Let op: welkomstmail kon niet worden verstuurd.\n' + (e?.text || e?.message || e));
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
    // Verwijder uit Firebase Auth via Cloud Function
    const deleteAuthUser = httpsCallable(functions, 'deleteAuthUser');
    await deleteAuthUser({ uid });
    // Verwijder Firestore roles doc
    await deleteDoc(doc(db, 'roles', uid));
  } catch (e) {
    alert(`Weigeren mislukt: ${e.message}`);
  }
};

window.adminDeleteUser = async (uid, name) => {
  if (uid === _adminUid) { alert('Je kunt jezelf niet verwijderen.'); return; }
  if (!confirm(`Gebruiker "${name}" definitief verwijderen?\nDit verwijdert hun account volledig.`)) return;
  try {
    // 1. Verwijder uit Firebase Auth via Cloud Function
    const deleteAuthUser = httpsCallable(functions, 'deleteAuthUser');
    await deleteAuthUser({ uid });
    // 2. Verwijder Firestore roles doc
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
    // Controleer of dit gebied al aan een andere manager is toegewezen
    const thisSnap = await getDoc(doc(db, 'roles', uid));
    const thisRole = thisSnap.data()?.role || '';

    if (thisRole === 'manager') {
      // Zoek alle andere managers met dit gebied
      const allSnap = await getDocs(collection(db, 'roles'));
      const conflictManagers = [];
      allSnap.forEach(d => {
        if (d.id === uid) return; // skip zichzelf
        const data = d.data();
        if (data.role === 'manager' && Array.isArray(data.zones) && data.zones.includes(zone)) {
          conflictManagers.push(data.displayName || data.email || d.id);
        }
      });
      if (conflictManagers.length > 0) {
        const namen = conflictManagers.join(', ');
        const doorgaan = confirm(
          `⚠️ Gebied "${zone.replace('Hoornaar_','')}" is al toegewezen aan: ${namen}.

` +
          `Bij doorgaan wordt dit gebied bij hen verwijderd en alleen aan deze beheerder toegewezen.

Doorgaan?`
        );
        if (!doorgaan) return;
        // Verwijder zone bij conflicterende managers
        for (const d of allSnap.docs) {
          if (d.id === uid) continue;
          const data = d.data();
          if (data.role === 'manager' && Array.isArray(data.zones) && data.zones.includes(zone)) {
            const newZones = data.zones.filter(z => z !== zone);
            await setDoc(doc(db, 'roles', d.id), { zones: newZones }, { merge: true });
          }
        }
      }
    }

    // Zone toevoegen aan de huidige gebruiker
    const zones = Array.isArray(thisSnap.data()?.zones) ? thisSnap.data().zones : [];
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

// ======================= Overzicht tab =======================
// Fix 102: overzicht rapport vanuit app-core weergeven in beheer scherm
let _overzichtLoaded = false;

function openOverzichtTab() {
  const body = document.getElementById('admin-body');
  if (!body) return;

  const curY = new Date().getFullYear();
  const yearOpts = Array.from({length: curY - 2019}, (_, i) => curY - i)
    .map(y => `<option value="${y}"${y===curY?' selected':''}>${y}</option>`).join('');

  body.innerHTML = `
    <div style="padding:12px">
      <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <select id="rpt-year" style="padding:5px 8px;border-radius:5px;border:1px solid #cbd5e1;font-size:12px;cursor:pointer">${yearOpts}</select>
        <button class="adm-rpt-btn active" data-days="today" style="padding:5px 10px;border-radius:5px;border:1px solid #cbd5e1;background:#0aa879;color:#fff;font-size:12px;cursor:pointer">Vandaag</button>
        <button class="adm-rpt-btn" data-days="7"   style="padding:5px 10px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-size:12px;cursor:pointer">Week</button>
        <button class="adm-rpt-btn" data-days="14"  style="padding:5px 10px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-size:12px;cursor:pointer">2 weken</button>
        <button class="adm-rpt-btn" data-days="30"  style="padding:5px 10px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-size:12px;cursor:pointer">Maand</button>
        <button class="adm-rpt-btn" data-days="365" style="padding:5px 10px;border-radius:5px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-size:12px;cursor:pointer">Jaar</button>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#475569;margin-left:4px;cursor:pointer">
          <input type="checkbox" id="rpt-exclude-gbif"/> GBIF uitsluiten
        </label>
      </div>
      <div id="report-content-modal" style="font-size:12px">
        <span style="color:#94a3b8">Laden...</span>
      </div>
    </div>`;

  body.querySelectorAll('.adm-rpt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      body.querySelectorAll('.adm-rpt-btn').forEach(b => {
        b.style.background = '#fff'; b.style.color = '#1e293b';
      });
      btn.style.background = '#0aa879'; btn.style.color = '#fff';
      const d = btn.dataset.days; _triggerReportLoad(d === 'today' ? 'today' : parseInt(d, 10));
    });
  });

  body.querySelector('#rpt-year')?.addEventListener('change', () => {
    const activeBtn = body.querySelector('.adm-rpt-btn[style*="#0aa879"]') || body.querySelector('.adm-rpt-btn');
    if (activeBtn) { const d = activeBtn.dataset.days; _triggerReportLoad(d === 'today' ? 'today' : parseInt(d, 10)); }
  });

  body.querySelector('#rpt-exclude-gbif')?.addEventListener('change', () => {
    const activeBtn = body.querySelector('.adm-rpt-btn[style*="#0aa879"]') || body.querySelector('.adm-rpt-btn');
    if (activeBtn) {
      const d = activeBtn.dataset.days;
      _triggerReportLoad(d === 'today' ? 'today' : parseInt(d, 10));
    }
  });

  _triggerReportLoad('today');
}

function _triggerReportLoad(days) {
  const excludeGbif = !!document.getElementById('rpt-exclude-gbif')?.checked;
  const year = document.getElementById('rpt-year')?.value || null;
  window.dispatchEvent(new CustomEvent('hornet:loadReport', {
    detail: { days, targetId: 'report-content-modal', excludeGbif, year }
  }));
}
