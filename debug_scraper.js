// debug_scraper.js – Analysiert die HTML-Struktur der JOYclub-Seite
const https = require('https');
const fs = require('fs');

const NOCODB_URL  = 'https://nocodb.f3-events.de';
const NOCODB_TOK  = '2l1BhPzXFj_Bb4pv9rKGpBMPZDkzpnKik7biab9-';
const PROJECT_ID  = 'pu4jkb0uwe4ebev';
const COOKIES_TBL = 'mmvneegxgeltpav';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

(async () => {
  // Cookie holen
  const cookieRes = await get(`${NOCODB_URL}/api/v1/db/data/noco/${PROJECT_ID}/${COOKIES_TBL}?limit=1`, { 'xc-token': NOCODB_TOK });
  const cookie = JSON.parse(cookieRes.body).list?.[0]?.Cookie;
  console.log('Cookie Länge:', cookie?.length);

  const joyHeaders = {
    'Cookie': cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'de-DE,de;q=0.9'
  };

  const res = await get('https://www.joyclub.de/party/veranstaltungen/13140845.f3.html', joyHeaders);
  const html = res.body;
  console.log('HTTP:', res.status, '| Größe:', html.length);

  // Alle cfnup-Bilder finden
  const imgMatches = [...html.matchAll(/data-src="(https:\/\/cfnup[^"]+)"/g)];
  console.log('\ncfnup Bilder gefunden:', imgMatches.length);
  imgMatches.forEach(m => console.log(' ', m[1].substring(0, 80)));

  // Alle Daten finden
  const dateMatches = [...html.matchAll(/(\d{2}\.\d{2}\.\d{4})/g)];
  const uniqueDates = [...new Set(dateMatches.map(m => m[1]))];
  console.log('\nDaten gefunden:', uniqueDates.join(', '));

  // Kontext um erstes cfnup-Bild
  if (imgMatches.length > 0) {
    const idx = imgMatches[0].index;
    const ctx = html.substring(idx - 100, idx + 400);
    console.log('\nKontext um erstes Bild:');
    console.log(ctx.replace(/<[^>]+>/g, '«TAG»').replace(/\s+/g, ' '));
  }

  // Alle Datums-Kontexte
  console.log('\n--- Datum-Kontexte ---');
  const seen = new Set();
  dateMatches.forEach(m => {
    if (seen.has(m[1])) return;
    seen.add(m[1]);
    const ctx = html.substring(Math.max(0, m.index - 200), m.index + 100);
    console.log(`\nDATUM: ${m[1]}`);
    console.log(ctx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 200));
  });

  // Suche nach Event-spezifischen Klassen
  console.log('\n--- Event-Klassen ---');
  const classPatterns = ['party_item', 'event_item', 'veranstaltung', 'sp_event', 'event-card', 'event_card', 'list_item'];
  classPatterns.forEach(cls => {
    if (html.includes(cls)) console.log('GEFUNDEN:', cls);
  });

  // Rohe Sektionen um ein Datum herum
  const dateIdx = html.indexOf('04.04.2026');
  if (dateIdx > 0) {
    console.log('\n--- Roh-HTML um 04.04.2026 ---');
    console.log(html.substring(dateIdx - 500, dateIdx + 300));
  }

  fs.writeFileSync('debug_current.html', html);
  console.log('\nHTML gespeichert: debug_current.html');
})().catch(e => console.error(e.message));
