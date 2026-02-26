const CACHE='hornet-610r21f13';
const ASSETS=[
'./',
'./index.html?v=610r21f16',
'./main_f16.js?v=610r21f16',
'./app_f16.css?v=610r21f16',
'./firebase_f16.js?v=610r21f16',
'./config_f16.js?v=610r21f16',
'./manifest_f16.webmanifest?v=610r21f16',
'./favicon.ico'
];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))) });
self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))) });
