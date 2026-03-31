// run_scraper.js – Einmalig ausführen zum Testen / initialen Befüllen
// Scrapt JOYclub mit Cookie, parst Events, speichert in Status-Store

const https = require('https');

const NOCODB_URL  = 'https://nocodb.f3-events.de';
const NOCODB_TOK  = '2l1BhPzXFj_Bb4pv9rKGpBMPZDkzpnKik7biab9-';
const PROJECT_ID  = 'pu4jkb0uwe4ebev';
const COOKIES_TBL = 'mmvneegxgeltpav';
// Dashboard-Proxy schreibt in Status-Store (nginx → f3-cookie-crawler:3000/status)
const STATUS_WRITE = 'https://dashboard.f3-events.de/proxy/status-write';

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

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseJoyclubHtml(html) {
  const events = [];
  if (!html || html.length < 1000) return events;

  // Struktur: <span class="navigation_link_title">NAME</span><span class="navigation_info_txt">DATE</span>
  const pat = /<span[^>]*navigation_link_title[^>]*>([^<]+)<\/span><span[^>]*navigation_info_txt[^>]*>([^<]+)<\/span>/g;
  let m;
  while ((m = pat.exec(html)) !== null) {
    const name  = m[1].trim();
    const datum = m[2].trim();

    if (!name || name.length < 3) continue;
    const dp = datum.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dp) continue;
    const isoDatum = `${dp[3]}-${dp[2]}-${dp[1]}`;

    // Im Bereich vor dem Match: Bild und Link suchen
    const before = html.substring(Math.max(0, m.index - 2000), m.index);

    const allImgs = [...before.matchAll(/data-src="(https:\/\/cfnup[^"]+)"/g)];
    const bild = allImgs.length ? allImgs[allImgs.length - 1][1] : '';

    const allLinks = [...before.matchAll(/href="(https?:\/\/www\.joyclub\.de\/(?:event|party)\/[^"]+)"/g)];
    const link = allLinks.length ? allLinks[allLinks.length - 1][1] : '';

    events.push({ name, datum, isoDatum, bild, link,
      angemeldet: 0, maenner: 0, frauen: 0, paare: 0, vorgemerkt: 0, nichtBestaetigt: 0, aufrufe: 0 });
  }
  return events;
}

(async () => {
  try {
    // 1. Cookie holen
    console.log('1. Cookie aus NocoDB holen...');
    const cookieRes = await get(`${NOCODB_URL}/api/v1/db/data/noco/${PROJECT_ID}/${COOKIES_TBL}?limit=1`, { 'xc-token': NOCODB_TOK });
    const cookieData = JSON.parse(cookieRes.body);
    const cookie = cookieData.list?.[0]?.Cookie;
    if (!cookie) throw new Error('Kein Cookie in NocoDB gefunden');
    console.log('   Cookie gefunden, Länge:', cookie.length);

    const joyHeaders = {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-DE,de;q=0.9'
    };

    // 2. Aktuelle Events scrapen
    console.log('2. Aktuelle Events scrapen...');
    const currentRes = await get('https://www.joyclub.de/party/veranstaltungen/13140845.f3.html', joyHeaders);
    console.log('   HTTP', currentRes.status, '| Größe:', currentRes.body.length, 'bytes');

    // 3. Archiv scrapen
    console.log('3. Archiv scrapen...');
    const archiveRes = await get('https://www.joyclub.de/party/veranstaltungen/13140845-archive.f3.html', joyHeaders);
    console.log('   HTTP', archiveRes.status, '| Größe:', archiveRes.body.length, 'bytes');

    // 4. Parsen
    console.log('4. HTML parsen...');
    const current = parseJoyclubHtml(currentRes.body);
    const archive = parseJoyclubHtml(archiveRes.body);
    console.log('   Aktuelle Events:', current.length);
    console.log('   Archiv Events:  ', archive.length);

    // Merge + deduplizieren
    const today = new Date(); today.setHours(0,0,0,0);
    const byName = {};
    [...current, ...archive].forEach(ev => {
      const key = ev.name.toLowerCase().trim();
      if (!byName[key] || ev.angemeldet > (byName[key].angemeldet || 0)) byName[key] = ev;
    });

    // Feldnamen NocoDB-kompatibel mappen (für events.js)
    const all = Object.values(byName).map(ev => {
      const evDate = ev.isoDatum ? new Date(ev.isoDatum) : null;
      const status = (evDate && evDate < today) ? 'inaktiv' : 'aktiv';
      return {
        EventName:        ev.name,
        EventDatum:       ev.datum,
        EventLink:        ev.link,
        Status:           status,
        Angemeldet:       ev.angemeldet   || 0,
        NichtBestaetigt:  ev.nichtBestaetigt || 0,
        Maenner:          ev.maenner      || 0,
        Frauen:           ev.frauen       || 0,
        Paare:            ev.paare        || 0,
        Vorgemerkt:       ev.vorgemerkt   || 0,
        Aufrufe:          ev.aufrufe      || 0,
        Bild:             ev.bild         || '',
        isoDatum:         ev.isoDatum,
      };
    }).sort((a, b) => (b.isoDatum || '').localeCompare(a.isoDatum || ''));

    console.log('\n   Gefundene Events gesamt:', all.length);
    all.forEach(ev => console.log(`   ${ev.isoDatum} | ${ev.Status.padEnd(7)} | ${ev.EventName}`));

    // 5. In Status-Store speichern (key='events' → /proxy/events-status liest davon)
    console.log('\n5. In Status-Store speichern...');
    const storePayload = { key: 'events', data: { events: all, count: all.length, scrapedAt: new Date().toISOString() } };
    const storeRes = await post(STATUS_WRITE, storePayload);
    console.log('   HTTP', storeRes.status, storeRes.body);

    // 6. Status-Store direkt testen
    console.log('\n6. Status-Store testen...');
    const statusRes = await get('https://dashboard.f3-events.de/proxy/events-status');
    try {
      const parsed = JSON.parse(statusRes.body);
      console.log('   HTTP', statusRes.status, '| Events:', parsed?.events?.length ?? 'kein events-Feld');
    } catch(e) {
      console.log('   HTTP', statusRes.status, '| Body:', statusRes.body.substring(0, 100));
    }

    console.log('\n✅ Fertig!');

  } catch(e) {
    console.error('✗ Fehler:', e.message);
  }
})();
