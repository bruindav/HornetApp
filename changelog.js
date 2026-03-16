// changelog.js — HoornaarZoeken
// ============================================================
// Voeg nieuwe fixes BOVENAAN toe (nieuwste eerst).
//
// Structuur per entry:
//   version  — fix nummer, bijv. 'Fix 149'
//   date     — datum in YYYY-MM-DD formaat
//   category — één van: Kaart | Acties | Overzicht | GBIF |
//               Gebieden | Account | Privacy | Uiterlijk |
//               Algemeen | Filter
//   text     — gebruiksvriendelijke omschrijving (max ~120 tekens)
// ============================================================

const CHANGELOG = [
  {
    version: 'Fix 153', date: '2026-03-17',
    category: 'Acties',
    text: 'Kompas telefoon gebruiken bij toevoegen zichtlijn. '
  },
  {
    version: 'Fix 148', date: '2026-03-17',
    category: 'Algemeen',
    text: 'Changelog verplaatst naar eigen bestand (changelog.js) voor eenvoudig beheer'
  },
  {
    version: 'Fix 147', date: '2026-03-17',
    category: 'Uiterlijk',
    text: 'Nieuwe iconen voor val (cilinder met rood roosterkapje) en lokpot (glazen pot met amber vloeistof). Overal dezelfde iconen — filter, actielijst en overzicht tonen nu dezelfde afbeeldingen als op de kaart'
  },
  {
    version: 'Fix 146', date: '2026-03-17',
    category: 'Kaart',
    text: 'Kleurkiezer toegevoegd aan zichtlijn popup — kies direct de kleur voor lijn en sector bij aanmaken'
  },
  {
    version: 'Fix 145', date: '2026-03-17',
    category: 'Kaart',
    text: 'Zichtlijn toevoegen heeft nu een gestylde popup met stopwatch — meet de vliegtijd heen+terug, klik "← Gebruik tijd" voor automatische afstandsberekening. Afstand ook handmatig invulbaar. Admin kan de berekeningsinstelling (seconden per meter) aanpassen via Beheer → Gebieden'
  },
  {
    version: 'Fix 144', date: '2026-03-17',
    category: 'Algemeen',
    text: '"🆕 Verbeteringen aan de app" knop onderin het zijmenu — toont overzicht van alle verbeteringen gegroepeerd per categorie'
  },
  {
    version: 'Fix 143', date: '2026-03-17',
    category: 'Acties',
    text: 'Adres automatisch toegevoegd aan acties — bijv. "Waarneming · Molenstraat 4, Zeist"'
  },
  {
    version: 'Fix 141–142', date: '2026-03-17',
    category: 'Acties',
    text: 'Actielijst werkt nu ook na opnieuw inloggen — acties worden bewaard in de cloud'
  },
  {
    version: 'Fix 140', date: '2026-03-17',
    category: 'Privacy',
    text: 'Privacygevoelige informatie (namen, e-mails) niet meer zichtbaar in browserconsole'
  },
  {
    version: 'Fix 139', date: '2026-03-17',
    category: 'Account',
    text: 'Verzoek tot accountverwijdering via Beheer-scherm — nette popup zonder URL-balk'
  },
  {
    version: 'Fix 137', date: '2026-03-17',
    category: 'Account',
    text: 'Privacybeleid-link en accountverwijdering verplaatst naar Beheer-scherm (naast kruisje)'
  },
  {
    version: 'Fix 136', date: '2026-03-16',
    category: 'Acties',
    text: 'Actielijst toont standaard de afgelopen week · Beheerder ziet acties van heel zijn gebied · "Meer..." knop bij meer dan 10 acties'
  },
  {
    version: 'Fix 134', date: '2026-03-16',
    category: 'Kaart',
    text: 'Klik op icoon toont eigenschappen (lezen). Lang indrukken om te wijzigen. Nieuw icoon opent altijd direct het invulscherm'
  },
  {
    version: 'Fix 133', date: '2026-03-16',
    category: 'Algemeen',
    text: 'App hernoemd naar HoornaarZoeken'
  },
  {
    version: 'Fix 131', date: '2026-03-16',
    category: 'Uiterlijk',
    text: 'Nieuw app-icoon: gestileerde Aziatische hoornaar met nest op groene achtergrond'
  },
  {
    version: 'Fix 127', date: '2026-03-16',
    category: 'Acties',
    text: 'Acties worden opgeslagen in de cloud — na inloggen zie je direct je recente acties terug'
  },
  {
    version: 'Fix 122', date: '2026-03-15',
    category: 'Gebieden',
    text: 'Kaartpicker bij toevoegen nieuw gebied — klik op de kaart voor het centrum. Bbox wordt automatisch berekend en getoond op een kaartje'
  },
  {
    version: 'Fix 119–120', date: '2026-03-15',
    category: 'Gebieden',
    text: 'Admin kan nieuwe plaatsen toevoegen (bijv. Doorn, Soest). Zones worden direct beschikbaar in alle overzichten en voor gebruikerstoewijzing'
  },
  {
    version: 'Fix 117', date: '2026-03-15',
    category: 'GBIF',
    text: 'GBIF-waarnemingen nu correct zichtbaar op kaart na inloggen · "Toon ruwe velden" knop in GBIF Sync om data te inspecteren'
  },
  {
    version: 'Fix 116', date: '2026-03-15',
    category: 'GBIF',
    text: 'GBIF gebruikt nu de originele coördinaat van waarneming.nl (verbatim) in plaats van de afgeronde gridcoördinaat'
  },
  {
    version: 'Fix 115', date: '2026-03-15',
    category: 'Kaart',
    text: 'Polygoon kopiëren naar ander jaar — rechtsklik op een polygoon → "Kopiëren naar jaar"'
  },
  {
    version: 'Fix 113', date: '2026-03-15',
    category: 'Overzicht',
    text: 'Overzicht heeft nu een jaar-selector — bekijk tellingen uit 2025 of eerder'
  },
  {
    version: 'Fix 111', date: '2026-03-15',
    category: 'Overzicht',
    text: 'GBIF-waarnemingen uitsluiten uit overzichtstellingen via "GBIF uitsluiten" checkbox'
  },
  {
    version: 'Fix 110', date: '2026-03-14',
    category: 'GBIF',
    text: 'GBIF-waarnemingen komen nu onder het juiste jaar (2025 ipv 2026) · Knop om alle GBIF te verwijderen en opnieuw te importeren'
  },
  {
    version: 'Fix 109', date: '2026-03-14',
    category: 'Kaart',
    text: 'Eigenschappen popup toont nu adres bij de locatie · GBIF-data volledig zichtbaar in popup'
  },
  {
    version: 'Fix 107', date: '2026-03-14',
    category: 'Filter',
    text: 'Filters verplaatst naar trechter-knop op de kaart · Actie-log in zijbalk · Adres automatisch bij eigenschappen-popup'
  },
  {
    version: 'Fix 105', date: '2026-03-14',
    category: 'Kaart',
    text: 'Zijbalk sluit automatisch na wisselen van gebied of jaar · "Pending" en "Stabiele interactie" opties verwijderd'
  },
  {
    version: 'Fix 103', date: '2026-03-13',
    category: 'Kaart',
    text: 'Kaart wisselt direct bij kiezen van ander jaar of gebied — geen "Toepassen" meer nodig'
  },
  {
    version: 'Fix 102', date: '2026-03-13',
    category: 'Overzicht',
    text: 'Overzicht verplaatst naar Beheer-scherm als eigen tab · Vrijwilligers en beheerders hebben nu ook toegang tot het overzicht'
  },
];
