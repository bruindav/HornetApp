// Fix 5 — cache versie verhoogd om oude app-core.js te wissen
const CACHE = 'hornet-v5';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([
      '/',
      '/index.html',
      '/app.css',
      '/favicon.ico',
      '/manifest.webmanifest',
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

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    const fresh = await fetch(req);
    cache.put(req, fresh.clone());
    return fresh;
  })());
});
