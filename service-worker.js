
const CACHE = 'hornet-mapper-v6-609g';
const ASSETS = ['./','./index.html?v=609g','./app.css?v=609g','./app.js?v=609g','./manifest.webmanifest?v=609g'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const key = url.pathname + (url.search || '');
  if (ASSETS.includes(key) || ASSETS.includes('.' + url.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
