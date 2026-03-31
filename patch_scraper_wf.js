// patch_scraper_wf.js – Aktualisiert den F3 JOYclub Events Scraper Workflow
const https = require('https');

const N8N_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const WF_ID  = '1IRCgHhZKSH9Lfpu';

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://n8n.f3-events.de' + path);
    https.get({ hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'X-N8N-API-KEY': N8N_KEY, 'User-Agent': 'nodejs' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

function apiPut(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'n8n.f3-events.de', path, method: 'PUT',
      headers: {
        'X-N8N-API-KEY': N8N_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
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

function apiPost(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'n8n.f3-events.de', path, method: 'POST',
      headers: { 'X-N8N-API-KEY': N8N_KEY, 'Content-Length': 0 }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

const NEW_PARSER_CODE = `
function parseJoyclubHtml(html) {
  const events = [];
  if (!html || html.length < 1000) return events;

  // Struktur: <span class="navigation_link_title">NAME</span><span class="navigation_info_txt">DATE</span>
  const pat = /<span[^>]*navigation_link_title[^>]*>([^<]+)<\\/span><span[^>]*navigation_info_txt[^>]*>([^<]+)<\\/span>/g;
  let m;
  while ((m = pat.exec(html)) !== null) {
    const name  = m[1].trim();
    const datum = m[2].trim();
    if (!name || name.length < 3) continue;
    const dp = datum.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
    if (!dp) continue;
    const isoDatum = dp[3] + '-' + dp[2] + '-' + dp[1];

    const before = html.substring(Math.max(0, m.index - 2000), m.index);
    const allImgs = [...before.matchAll(/data-src="(https:\\/\\/cfnup[^"]+)"/g)];
    const bild = allImgs.length ? allImgs[allImgs.length - 1][1] : '';
    const allLinks = [...before.matchAll(/href="(https?:\\/\\/www\\.joyclub\\.de\\/(?:event|party)\\/[^"]+)"/g)];
    const link = allLinks.length ? allLinks[allLinks.length - 1][1] : '';

    events.push({ name, datum, isoDatum, bild, link });
  }
  return events;
}

const today = new Date(); today.setHours(0,0,0,0);
const items = $input.all();
const htmlCurrent = items[0]?.json?.data || '';
const htmlArchive = items[1]?.json?.data || '';

const current = parseJoyclubHtml(htmlCurrent);
const archive = parseJoyclubHtml(htmlArchive);

// Merge + deduplizieren nach Name
const byName = {};
[...current, ...archive].forEach(ev => {
  const key = ev.name.toLowerCase().trim();
  if (!byName[key]) byName[key] = ev;
});

// NocoDB-kompatible Feldnamen + Status
const all = Object.values(byName).map(ev => {
  const evDate = ev.isoDatum ? new Date(ev.isoDatum) : null;
  const Status = (evDate && evDate < today) ? 'inaktiv' : 'aktiv';
  return {
    EventName:       ev.name,
    EventDatum:      ev.datum,
    EventLink:       ev.link,
    Bild:            ev.bild,
    Status,
    isoDatum:        ev.isoDatum,
    Angemeldet:      0,
    NichtBestaetigt: 0,
    Maenner:         0,
    Frauen:          0,
    Paare:           0,
    Vorgemerkt:      0,
    Aufrufe:         0,
  };
}).sort((a, b) => (b.isoDatum || '').localeCompare(a.isoDatum || ''));

console.log('Events gefunden:', all.length);
return [{ json: { events: all, count: all.length, scrapedAt: new Date().toISOString() } }];
`;

(async () => {
  console.log('1. Scraper Workflow holen...');
  const res = await apiGet(`/api/v1/workflows/${WF_ID}`);
  const wf = JSON.parse(res.body);

  // Code node updaten
  const codeNode = wf.nodes.find(n => n.name.includes('Code: Events parsen'));
  if (!codeNode) throw new Error('Code node nicht gefunden');
  codeNode.parameters.jsCode = NEW_PARSER_CODE.trim();
  console.log('   Code node aktualisiert (neuer Parser + NocoDB-Feldnamen)');

  // Status-Store Node: Body so setzen dass key='events' gesendet wird
  const storeNode = wf.nodes.find(n => n.name.includes('Status-Store'));
  if (storeNode) {
    // HTTP Request node body - muss als sendBody mit JSON gesetzt werden
    storeNode.parameters.sendBody = true;
    storeNode.parameters.contentType = 'json';
    storeNode.parameters.body = '={{ { "key": "events", "data": $json } }}';
    console.log('   Status-Store node: key="events" gesetzt');
  }

  // 2. Zurückschreiben
  console.log('2. Workflow speichern...');
  const { executionOrder, errorWorkflow, callerPolicy } = wf.settings || {};
  const putRes = await apiPut(`/api/v1/workflows/${WF_ID}`, {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: { executionOrder, errorWorkflow, callerPolicy },
    staticData: wf.staticData || null
  });
  console.log('   PUT HTTP', putRes.status);
  if (putRes.status !== 200) console.log('   Fehler:', putRes.body.substring(0, 300));

  // 3. Reaktivieren
  console.log('3. Workflow reaktivieren...');
  const actRes = await apiPost(`/api/v1/workflows/${WF_ID}/activate`);
  console.log('   HTTP', actRes.status);

  console.log('\nFertig! Scraper wird täglich 05:00 Uhr laufen.');
  console.log('Manuell triggern: node run_scraper.js');
})().catch(e => console.error('Fehler:', e.message));
