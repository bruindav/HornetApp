import { getFirestore, collection, getDocs, doc, getDoc, setDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';

import './firebase.js?v=610r21f13';
import './sync-engine.js?v=610r21f12b';

// ============================================================
// Hornet Mapper NL — main.js (volledig opgeschoond en hersteld)
// ============================================================

// ------------------------------------------------------------
// Kleine helpers
// ------------------------------------------------------------
function $(id) { return document.getElementById(id); }
function on(el, ev, fn) { if (el) el.addEventListener(ev, fn, { passive: true }); }
function req(id) { const el = $(id); if (!el) console.warn(`[UI] Element met id="${id}" niet gevonden`); return el; }
function nowISODate() { return new Date().toISOString().slice(0, 10); }
function genId(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`; }

function debounceEventGate(msGetter) {
    let last = 0;
    return () => {
        const ms = msGetter();
        const t = Date.now();
        if (t - last < ms) return true;
        last = t;
        return false;
    };
}

// ------------------------------------------------------------
// Auth UI injectie
// ------------------------------------------------------------
function ensureAuthUI() {
    const bar = document.getElementById('status-bar');
    if (!bar) return;

    if (!document.getElementById('whoami')) {
        const who = document.createElement('span');
        who.id = 'whoami';
        who.textContent = '(niet ingelogd)';

        const btnIn = document.createElement('button');
        btnIn.id = 'btn-signin';
        btnIn.textContent = 'Inloggen';

        const btnOut = document.createElement('button');
        btnOut.id = 'btn-signout';
        btnOut.textContent = 'Uitloggen';
        btnOut.hidden = true;

        const role = document.createElement('span');
        role.id = 'role-indicator';
        role.textContent = 'Rol: gast';

        bar.appendChild(who);
        bar.appendChild(btnIn);
        bar.appendChild(btnOut);
        bar.appendChild(role);
    }
}

// ------------------------------------------------------------
// Auth & Rollen
// ------------------------------------------------------------
let CURRENT_USER = null;
let CURRENT_ROLE = "guest";
let ALLOWED_ZONES = [];

function isAdmin() {
    return CURRENT_ROLE === "admin" || CURRENT_ROLE === "beheerder";
}

function canWriteZone(z) {
    return isAdmin() || (ALLOWED_ZONES || []).includes(z);
}

// ------------------------------------------------------------
// Status UI
// ------------------------------------------------------------
const statusSW = $('status-sw');
const statusGeo = $('status-geo');

function setStatus(el, text, cls) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('ok', 'warn', 'err');
    if (cls) el.classList.add(cls);
}

function updateSWStatus() {
    try {
        if (!('serviceWorker' in navigator)) {
            setStatus(statusSW, 'SW: niet ondersteund', 'warn');
            return;
        }
        const st = navigator.serviceWorker.controller ? 'actief' : 'geregistreerd';
        setStatus(statusSW, `SW: ${st}`, 'ok');
    } catch { }
}

// ------------------------------------------------------------
// Debounce
// ------------------------------------------------------------
const SOFT_MS = 150, HARD_MS = 300;
let DEBOUNCE_MS = SOFT_MS;
const shouldDebounce = debounceEventGate(() => DEBOUNCE_MS);

// ------------------------------------------------------------
// Map & Layers
// ------------------------------------------------------------
let map;
const markersGroup = L.featureGroup();
const linesGroup = L.featureGroup();
const circlesGroup = L.featureGroup();
const handlesGroup = L.featureGroup();
const polygonsGroup = L.featureGroup();

let allMarkers = [], allLines = [], allSectors = [];

function initMap() {
    map = L.map('map', { zoomControl: true }).setView([52.1, 5.3], 8);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap-bijdragers'
    }).addTo(map);

    markersGroup.addTo(map);
    linesGroup.addTo(map);
    circlesGroup.addTo(map);
    handlesGroup.addTo(map);
    polygonsGroup.addTo(map);

    map.pm.addControls({
        position: 'topleft',
        drawMarker: false,
        drawPolyline: false,
        drawRectangle: true,
        drawPolygon: true,
        drawCircle: false,
        drawCircleMarker: false,
        editMode: true,
        dragMode: true,
        cutPolygon: false,
        removalMode: true
    });

    map.on('pm:create', e => {
        const layer = e.layer;
        if (e.shape === 'Polygon' || e.shape === 'Rectangle') {
            polygonsGroup.addLayer(layer);
            initPolygon(layer);
            persistPolygon(layer);
        } else layer.remove();
    });

    let drawing = false;

    map.on('pm:drawstart', () => drawing = true);
    map.on('pm:drawend', () => drawing = false);

    map.on('click', e => {
        if (shouldDebounce()) return;
        if (drawing) return;
        openMapContextMenu(e.latlng, e.originalEvent?.clientX || 0, e.originalEvent?.clientY || 0);
    });

    map.on('contextmenu', e => {
        if (shouldDebounce()) return;
        if (drawing) return;
        openMapContextMenu(e.latlng, e.originalEvent?.clientX || 0, e.originalEvent?.clientY || 0);
    });
}

// ------------------------------------------------------------
// Zoekfunctie (ontbrak en veroorzaakte app-crash)
// ------------------------------------------------------------
async function searchPlaceNL() {
    try {
        const place = document.getElementById('place-input')?.value?.trim();
        if (!place) return;

        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(place)}&limit=1`;
        const res = await fetch(url);
        const json = await res.json();

        if (!json.features || !json.features.length) {
            alert('Geen resultaat gevonden');
            return;
        }

        const coords = json.features[0].geometry.coordinates;
        const latlng = [coords[1], coords[0]];

        map.setView(latlng, 14);

        const overlay = document.getElementById('search-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
        }

    } catch (e) {
        console.error('[searchPlaceNL]', e);
        alert('Zoekfout');
    }
}

// ------------------------------------------------------------
// UI Bindings
// ------------------------------------------------------------
function initUIBindings() {

    const backdrop = req('sidebar-backdrop');

    function setSidebar(open) {
        document.body.classList.toggle('sidebar-collapsed', !open);
        document.body.classList.toggle('sidebar-open', !!open);

        if (backdrop) {
            if (open) backdrop.removeAttribute('hidden');
            else backdrop.setAttribute('hidden', '');
        }

        setTimeout(() => { try { map?.invalidateSize(); } catch { } }, 150);
    }

    on(req('toggle-sidebar'), 'click', () => {
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        setSidebar(collapsed);
    });

    on(backdrop, 'click', () => setSidebar(false));

    if (window.matchMedia('(max-width: 900px)').matches) setSidebar(false);

    on(req('hard-debounce'), 'change', e => {
        DEBOUNCE_MS = e.target.checked ? HARD_MS : SOFT_MS;
    });

    const floatingSearchBtn = req('floating-search-btn');
    const searchOverlay = req('search-overlay');
    const searchClose = req('search-close');
    const searchBtn = req('search-btn');
    const placeInput = req('place-input');

    on(floatingSearchBtn, 'click', () => {
        if (!searchOverlay || !placeInput) return;
        searchOverlay.classList.add('active');
        searchOverlay.setAttribute('aria-hidden', 'false');
        placeInput.focus();
    });

    on(searchClose, 'click', () => {
        if (!searchOverlay) return;
        searchOverlay.classList.remove('active');
        searchOverlay.setAttribute('aria-hidden', 'true');
    });

    on(placeInput, 'keydown', e => { if (e.key === 'Enter') searchPlaceNL(); });
    on(searchBtn, 'click', searchPlaceNL);

    on(req('apply-filters'), 'click', applyFilters);

    on(req('reset-filters'), 'click', () => {
        ['f_type_hoornaar', 'f_type_nest', 'f_type_nest_geruimd', 'f_type_lokpot', 'f_type_pending']
            .forEach(id => { const el = $(id); if (el) el.checked = true; });
        const fdb = $('f_date_before');
        if (fdb) fdb.value = '';
        applyFilters();
    });

    on(req('btn-selftest'), 'click', async () => {
        try { await geocodePhoton('Utrecht'); setStatus(statusGeo, 'Photon OK', 'ok'); }
        catch { setStatus(statusGeo, 'Photon NOK', 'err'); }

        const key = $('mapsco-key')?.value?.trim() || '';

        try { await geocodeMapsCo('Utrecht', key); setStatus(statusGeo, 'Maps.co OK', 'ok'); }
        catch { setStatus(statusGeo, 'Maps.co NOK', 'err'); }
    });

    on(req('btn-reset-cache'), 'click', async () => {
        try {
            if ('caches' in window) {
                const ks = await caches.keys();
                await Promise.all(ks.map(k => caches.delete(k)));
            }
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }

            localStorage.clear();
            alert('Cache & SW gereset. Herladen…');
            location.reload(true);
        } catch {
            alert('Reset mislukt');
        }
    });

    updateSWStatus();

    try { ensureAuthUI(); } catch { }
}

// ------------------------------------------------------------
// Admin functies
// ------------------------------------------------------------
async function adminRefresh() {
    try {
        if (!(CURRENT_ROLE === 'admin' || CURRENT_ROLE === 'beheerder')) {
            const list = document.getElementById('admin-list');
            if (list) list.innerHTML = '<i>Alleen beheerders kunnen rollen beheren.</i>';
            return;
        }

        const db = getFirestore();
        const snap = await getDocs(collection(db, 'roles'));
        const items = [];

        snap.forEach(d => {
            const data = d.data() || {};
            items.push({
                uid: d.id,
                rol: data.rol || '(geen)',
                gebieden: Array.isArray(data.gebieden) ? data.gebieden : []
            });
        });

        const list = document.getElementById('admin-list');
        list.innerHTML = items.length
            ? items.map(it => `
<div class="adm-row" data-uid="${it.uid}" style="padding:6px;border-bottom:1px solid var(--border2);cursor:pointer">
<b>${it.uid}</b><br>
rol: ${it.rol} — gebieden: ${(it.gebieden || []).join(', ') || '-'}
</div>`).join('')
            : '<i>Geen rollen gevonden.</i>';

        list.querySelectorAll('.adm-row').forEach(row => {
            row.addEventListener('click', async () => {
                const uid = row.dataset.uid;
                const ref = doc(getFirestore(), 'roles', uid);
                const s = await getDoc(ref);
                const d = s.exists() ? s.data() : { rol: 'vrijwilliger', gebieden: [] };

                document.getElementById('adm-uid').value = uid;
                document.getElementById('adm-rol').value = d.rol || 'vrijwilliger';
                document.querySelectorAll('.adm-area').forEach(cb => {
                    cb.checked = Array.isArray(d.gebieden) ? d.gebieden.includes(cb.value) : false;
                });
            });
        });

    } catch (e) {
        console.error('[adminRefresh]', e);
        alert('Fout bij laden rollen.');
    }
}

async function adminSave() {
    try {
        if (!(CURRENT_ROLE === 'admin' || CURRENT_ROLE === 'beheerder')) return;

        const uid = document.getElementById('adm-uid').value.trim();
        if (!uid) { alert('Vul een UID in.'); return; }

        const rol = document.getElementById('adm-rol').value;
        const areas = Array.from(document.querySelectorAll('.adm-area'))
            .filter(cb => cb.checked)
            .map(cb => cb.value);

        await setDoc(doc(getFirestore(), 'roles', uid), { rol, gebieden: areas }, { merge: true });

        alert('Opgeslagen.');
        adminRefresh();

