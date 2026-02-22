
const CACHE = 'hornet-mapper-v5-609d';
const ASSETS = ['./','./index.html?v=609d','./app.css?v=609d','./app.js?v=609d','./manifest.webmanifest?v=609d'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const key = url.pathname + (url.search || '');
  if (ASSETS.includes(key) || ASSETS.includes('.' + url.pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
