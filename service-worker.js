
const CACHE = 'hornet-610r21f11';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    './', './index.html?v=610r21f11', './app.css?v=610r21f11', './app.js?v=610r21f11', './firebase.js?v=610r21f11', './config.js?v=610r21f11', './manifest.webmanifest?v=610r21f11', './favicon.ico'
  ])));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
