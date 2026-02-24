const CACHE = 'hornet-mapper-v610r21f4';
const ASSETS = [
  './',
  './index.html?v=610r21f4',
  './app.css?v=610r21f4',
  './app.js?v=610r21f4',
  './manifest.webmanifest?v=610r21f4'
];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); });
