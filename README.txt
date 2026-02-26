
HornetApp – Fix bundle (26-02-2026)
===================================

Wat is dit?
-----------
Een minimale, werkende set bestanden die de gevonden problemen oplost:
- dubbele initialisatie (slechts 1 script-tag voor main.js)
- idempotente Leaflet-map init
- export/import van openMapContextMenu
- Firebase singleton init
- Service Worker met veilige cache-strategie

Hoe toepassen
-------------
1) **Maak een backup** van je bestaande bestanden.
2) Kopieer de bestanden uit deze zip naar je webroot. Pas zo nodig aan:
   - Vul `config.js` met je echte Firebase-config.
   - Integreer je eigen HTML en CSS in `index.html` en `app.css`.
   - Zorg dat Leaflet JS/CSS ook in `index.html` wordt geladen (CDN of lokaal).
3) Start lokaal of push naar je hosting.
4) Open DevTools → Application → Service Workers → *Unregister* en doe een **Hard Reload**.

Belangrijke notities
--------------------
- Zorg dat er **slechts 1** `<script type="module" src="./main.js?...">` tag in `index.html` staat.
- Als je al een eigen `openMapContextMenu` hebt, vervang dan de demo-functie in `sync-engine.js`.
- Pas de versie in `index.html` en `service-worker.js` aan bij een release (bijv. v610r21f18).

Succes!
