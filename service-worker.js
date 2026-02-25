const CACHE='hornet-610r21f12';
self.addEventListener('install', e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./index.html?v=610r21f12','./app.js?v=610r21f12','./app.css?v=610r21f12','./firebase.js?v=610r21f12','./config.js?v=610r21f12','./manifest.webmanifest?v=610r21f12','./favicon.ico']))) });
self.addEventListener('activate', e=>{ e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))) });
self.addEventListener('fetch', e=>{ e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))) });