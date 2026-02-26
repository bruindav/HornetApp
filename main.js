import { getFirestore, collection, getDocs, doc, getDoc, setDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js';

import './firebase.js?v=610r21f13';
import './sync-engine.js?v=610r21f12b';

// ============================================================
// Hornet Mapper NL — main.js (gereconstrueerd en opgeschoond)
// ============================================================

// Vereist (door index.html alléén app.js te laden):
// sync-engine.js → firebase.js → config.js
// Leaflet + Geoman moeten VÓÓR dit bestand geladen zijn.

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

