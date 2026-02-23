
const CACHE = 'hornet-mapper-v6-609e';
const ASSETS = ['./','./index.html?v=609e','./app.css?v=609e','./app.js?v=609e','./manifest.webmanifest?v=609e'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const key = url.pathname + (url.search || '');
  if (ASSETS.includes(key) || ASSETS.includes('.' + url.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
