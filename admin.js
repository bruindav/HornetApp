// admin.js — Fix 76
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
const functions = getFunctions(app, 'europe-west4');

// ======================= EmailJS configuratie =======================
// BELANGRIJK: vul hier je eigen keys in vanuit emailjs.com
const EMAILJS_SERVICE_ID  = 'service_am7yhzo';
const EMAILJS_TEMPLATE_ID = 'template_8jyfjkf';
const EMAILJS_PUBLIC_KEY  = 'grly1relpuAh_73z7';

const KNOWN_ZONES = [
  'Zeist',
  'Bilthoven',
  'Driebergen',
  'Utrecht',
];

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
      .adm-tabs { display: flex; gap: 0; border-bottom: 2px solid #e2e8f0; margin-bottom: 0; }
      .adm-tab { padding: 10px 18px; border: 0; background: none; cursor: pointer; font-size: 13px; font-weight: 600; color: #64748b; border-bottom: 3px solid transparent; margin-bottom: -2px; }
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
      <div class="adm-tabs">
        <button class="adm-tab active" data-tab="users">👥 Gebruikers</button>
        <button class="adm-tab" data-tab="sync">🔄 Waarneming.nl</button>
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
      if (btn.dataset.tab === 'users') startListening();
      else if (btn.dataset.tab === 'sync') openSyncTab();
    });
  });
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

// ======================= Waarneming.nl Sync =======================
// Species ID Aziatische hoornaar (Vespa velutina) op waarneming.nl
const WAARNEMING_SPECIES_ID = 8807;
// CORS proxy — nodig omdat browser de waarneming.nl API niet direct kan aanroepen
const CORS_PROXY = 'https://corsproxy.io/?';

// Zones met hun bounding boxes [minLat, minLng, maxLat, maxLng]
const ZONE_BOUNDS = {
  'Zeist':      [52.05, 5.17, 52.14, 5.33],
  'Bilthoven':  [52.09, 5.14, 52.18, 5.26],
  'Driebergen': [52.02, 5.24, 52.09, 5.35],
  'Utrecht':    [52.04, 5.03, 52.15, 5.18],
};

function openSyncTab() {
  const lastSync = localStorage.getItem('wn_last_sync') || '';
  const token    = localStorage.getItem('wn_token') || '';
  setAdminBody(`
    <div style="padding:16px;max-width:600px">
      <h3 style="margin:0 0 4px;font-size:15px">🔄 Synchronisatie met waarneming.nl</h3>
      <p style="color:#64748b;font-size:12px;margin:0 0 16px">
        Importeert waarnemingen van Aziatische hoornaar (Vespa velutina, soort #${WAARNEMING_SPECIES_ID})
        binnen jouw gebieden.
      </p>

      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px">
          Waarneming.nl API token (Bearer)
        </label>
        <div class="adm-sync-row">
          <input id="wn-token" class="adm-sync-input" type="password"
            placeholder="Plak hier je OAuth2 token van waarneming.nl"
            value="${token}"/>
          <button class="adm-sync-btn" id="wn-save-token" style="background:#475569">Opslaan</button>
        </div>
        <p style="font-size:11px;color:#94a3b8;margin:2px 0 0">
          Haal je token op via: waarneming.nl → Mijn profiel → API-toegang → Token aanmaken
        </p>
      </div>

      <div style="margin-bottom:14px">
        <label style="font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px">
          Synchroniseren vanaf
        </label>
        <div class="adm-sync-row">
          <input id="wn-date" type="date" class="adm-sync-input" style="max-width:180px"
            value="${lastSync ? lastSync.slice(0,10) : new Date(Date.now()-7*86400000).toISOString().slice(0,10)}"/>
          <button class="adm-sync-btn" id="wn-sync-btn">▶ Synchroniseren</button>
        </div>
        ${lastSync ? `<p style="font-size:11px;color:#94a3b8;margin:2px 0 0">Laatste sync: ${new Date(lastSync).toLocaleString('nl-NL')}</p>` : ''}
      </div>

      <div id="wn-log" class="adm-sync-log" style="min-height:60px">
        <span style="color:#94a3b8">Klik op Synchroniseren om te starten.</span>
      </div>
    </div>
  `);

  document.getElementById('wn-save-token')?.addEventListener('click', () => {
    const t = document.getElementById('wn-token')?.value.trim();
    if (t) { localStorage.setItem('wn_token', t); alert('Token opgeslagen.'); }
  });

  document.getElementById('wn-sync-btn')?.addEventListener('click', () => runSync());
}

function logSync(msg, color='#334155') {
  const log = document.getElementById('wn-log');
  if (!log) return;
  const line = document.createElement('div');
  line.style.cssText = 'padding:2px 0;color:' + color;
  line.textContent = new Date().toLocaleTimeString('nl-NL') + ' — ' + msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function runSync() {
  const token   = localStorage.getItem('wn_token') || document.getElementById('wn-token')?.value.trim();
  const dateStr = document.getElementById('wn-date')?.value;
  const btn     = document.getElementById('wn-sync-btn');
  const log     = document.getElementById('wn-log');

  if (!token) { alert('Stel eerst een API token in.'); return; }
  if (!dateStr) { alert('Stel een datum in.'); return; }

  log.innerHTML = '';
  btn.disabled = true;
  btn.textContent = '⏳ Bezig…';
  logSync('Start synchronisatie vanaf ' + dateStr);

  const year = new Date().getFullYear().toString();
  let totalImported = 0, totalSkipped = 0, totalDuplicates = 0;

  try {
    // Haal alle waarnemingen op (gepagineerd)
    let url = `https://waarneming.nl/api/v1/species/${WAARNEMING_SPECIES_ID}/observations/?date_after=${dateStr}&limit=100&offset=0`;
    let allObs = [];
    let page = 0;

    while (url) {
      page++;
      logSync(`Pagina ${page} ophalen…`, '#64748b');
      const proxyUrl = CORS_PROXY + encodeURIComponent(url);
      const resp = await fetch(proxyUrl, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
      if (!resp.ok) {
        logSync(`API fout: ${resp.status} ${resp.statusText}`, '#ef4444');
        break;
      }
      const data = await resp.json();
      allObs = allObs.concat(data.results || []);
      logSync(`${allObs.length} van ${data.count} waarnemingen opgehaald`, '#64748b');
      url = data.next || null;
      if (page > 20) { logSync('Stop na 20 pagina's (max 2000 waarnemingen).', '#f59e0b'); break; }
    }

    logSync(`Totaal ${allObs.length} waarnemingen gevonden voor soort Aziatische hoornaar.`);

    // Filter op jouw zones via bounding box
    for (const [zone, bbox] of Object.entries(ZONE_BOUNDS)) {
      const [minLat, minLng, maxLat, maxLng] = bbox;
      const inZone = allObs.filter(o => {
        if (!o.point?.coordinates) return false;
        const [lng, lat] = o.point.coordinates;
        return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
      });
      if (!inZone.length) { logSync(`${zone}: geen waarnemingen`, '#94a3b8'); continue; }
      logSync(`${zone}: ${inZone.length} waarneming(en) gevonden`);

      // Per waarneming importeren
      for (const obs of inZone) {
        const obsId = 'wn_' + obs.id;
        const [lng, lat] = obs.point.coordinates;
        const date = obs.date || new Date().toISOString().slice(0,10);
        const locName = obs.location_detail?.name || '';
        const userName = obs.user_detail?.name || obs.observer || ('gebruiker #' + obs.user);
        const notes  = [obs.notes, locName].filter(Boolean).join(' | ');
        const aantal = obs.number || 1;

        // Controleer of al aanwezig (op externalId)
        const base = 'maps/' + year + '/' + zone + '/data';
        const existing = await getDocs(
          query(collection(db, base, 'markers'), where('externalId', '==', obsId))
        );
        if (!existing.empty) { totalDuplicates++; continue; }

        // Geocode adres via Nominatim als locatienaam beschikbaar
        let adres = locName;
        if (!adres && lat && lng) {
          try {
            const geo = await fetch(
              'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&accept-language=nl',
              { headers: { 'User-Agent': 'HornetApp/1.0' } }
            );
            const geoData = await geo.json();
            adres = geoData.display_name?.split(',').slice(0,3).join(', ') || '';
          } catch {}
        }

        // Marker aanmaken in Firestore
        const id = 'wn_' + obs.id;
        const markerDoc = {
          id, type: 'hoornaar',
          lat, lng,
          date,
          by: userName,
          aantal,
          note: [notes, adres ? ('📍 ' + adres) : ''].filter(Boolean).join('\n'),
          externalId: obsId,
          source: 'waarneming.nl',
          permalink: obs.permalink || '',
          validationStatus: obs.validation_status || '',
        };
        await setDoc(doc(db, base, 'markers', id), markerDoc);
        totalImported++;
        logSync(`✅ Geïmporteerd: ${date} | ${userName} | ${antal_label(aantal)} | ${adres||'onbekend'}`, '#0aa879');
      }
    }

    // Laatste sync opslaan
    localStorage.setItem('wn_last_sync', new Date().toISOString());
    logSync('────────────────────────────────', '#e2e8f0');
    logSync('Klaar! ' + totalImported + ' geïmporteerd, ' + totalDuplicates + ' duplicaten overgeslagen, ' + totalSkipped + ' buiten gebieden.', '#0aa879');

  } catch(e) {
    logSync('Fout: ' + e.message, '#ef4444');
    console.error('[sync] fout:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Synchroniseren';
  }
}

function antal_label(n) { return n === 1 ? '1 exemplaar' : n + ' exemplaren'; }

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
