const CACHE = 'hornet-mapper-v610r21f5';
const ASSETS = [
  './',
  './index.html?v=610r21f5',
  './app.css?v=610r21f5',
  './app.js?v=610r21f5',
  './manifest.webmanifest?v=610r21f5'
];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); });
