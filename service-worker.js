// service-worker.js — Fix 125
const CACHE_STATIC = 'hornet-static-v125';
const CACHE_DYNAMIC = 'hornet-dynamic-v125';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/manifest.webmanifest',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.ico',
];

// Install: cache statische assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_STATIC).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

// Activate: verwijder oude caches
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n !== CACHE_STATIC && n !== CACHE_DYNAMIC)
        .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Externe API's altijd via netwerk (Firebase, Nominatim, GBIF, OSM tiles)
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('nominatim') ||
    url.hostname.includes('gbif.org') ||
    url.hostname.includes('openstreetmap.org') ||
    url.hostname.includes('tile.openstreetmap') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('geoapify')
  ) {
    return; // laat browser afhandelen
  }

  // JS/CSS modules: network-first (altijd verse versie, fallback op cache)
  if (req.destination === 'script' || req.destination === 'style') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_DYNAMIC);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_DYNAMIC);
        return await cache.match(req) || Response.error();
      }
    })());
    return;
  }

  // Iconen en statische bestanden: cache-first
  if (req.destination === 'image' || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const staticCache = await caches.open(CACHE_STATIC);
      const cached = await staticCache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        staticCache.put(req, fresh.clone());
        return fresh;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // HTML (navigatie): network-first, fallback op /index.html
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(CACHE_STATIC);
        return await cache.match('/index.html') || Response.error();
      }
    })());
    return;
  }

  // Overige requests: network met dynamische cache als fallback
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_DYNAMIC);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cache = await caches.open(CACHE_DYNAMIC);
      return await cache.match(req) || Response.error();
    }
  })());
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([
      '/',
      '/index.html',
      '/app.css',
      '/favicon.ico',
      '/manifest.webmanifest',
      // bewust geen main.js hier, zodat we geen oude versie pinnen
    ]))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => n !== CACHE && caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.destination === 'script') {
    // network-first voor scripts (zoals main.js)
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // default: cache-first
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});
