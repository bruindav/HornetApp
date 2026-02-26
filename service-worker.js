const CACHE='hornet-610r21f15';
const ASSETS=[
'./',
'./index.html?v=610r21f15',
'./main.js?v=610r21f15',
'./app.css?v=610r21f15',
'./firebase.js?v=610r21f15',
'./config.js?v=610r21f15',
'./manifest.webmanifest?v=610r21f15',
'./favicon.ico'
];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))) });
self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))) });
