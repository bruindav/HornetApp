
# Hornet Mapper NL — 6.0.9j-R2

## Wat is nieuw t.o.v. 6.0.9i
- Unified **contextmenu** voor polygonen + icoonacties
- **Zichtlijnen** vanuit lokpot (meerdere per lokpot) met handle & sector ±45°
- **Datepicker‑modal** (default vandaag) voor iconen
- **Filter** verbergt lijnen mee met lokpotten
- **Export/Import** van markers, zichtlijnen en polygonen
- **Service Worker bump** (v609j-r2)
- **Firestore voorbereiding (UIT)** — zie `app.js` → `ENABLE_FIRESTORE`

## Publiceren
1. Vervang alle bestanden in de repo‑root
2. Commit & push
3. Pages publiceert automatisch; bij twijfel: Cache reset in de app

## Licenties / CDN
- Leaflet 1.9.4 (CDN)
- Leaflet‑Geoman Free (CDN @latest)
- Firebase JS SDK (optioneel) via CDN (wanneer ingeschakeld)
