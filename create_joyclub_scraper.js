// create_joyclub_scraper.js
// Erstellt:
// 1. "F3 JOYclub Events Scraper" – scrapt JOYclub, speichert in Status-Store
// 2. Aktualisiert "F3 Events API" – liest zuerst Status-Store, Fallback NocoDB

const https = require('https');

const N8N_HOST   = 'n8n.f3-events.de';
const N8N_KEY    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const NOCODB_URL = 'https://nocodb.f3-events.de';
const NOCODB_TOK = '2l1BhPzXFj_Bb4pv9rKGpBMPZDkzpnKik7biab9-';
const PROJECT_ID = 'pu4jkb0uwe4ebev';
const EVENTS_TBL = 'mo0qnkmte1sl1mj';
const COOKIES_TBL= 'mmvneegxgeltpav';
// Status-Store: interner Docker-Service (n8n → f3-cookie-crawler:3000)
const STATUS_URL = 'http://f3-cookie-crawler:3000/status';

// ── HTML-Parser ───────────────────────────────────────────────────────────────
const PARSE_CODE = `
function parseJoyclubHtml(html) {
  const events = [];
  if (!html || html.length < 1000) return events;

  // Muster: data-src="img_url" /> EventName DD.MM.YYYY
  const pat = /data-src="(https:\\/\\/cfnup[^"]{10,200})"[^\\n]*?\\/>([\\s\\S]{2,150}?)(\\d{2}\\.\\d{2}\\.\\d{4})/g;
  let m;
  while ((m = pat.exec(html)) !== null) {
    const imgUrl = m[1];
    const name   = m[2].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
    const datum  = m[3];
    if (!name || name.length < 3 || name.length > 120) continue;
    if (/^(Navigation|Profil|Fotos|Suche|Login|Menü|Team)/i.test(name)) continue;

    const dp = datum.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
    const isoDatum = dp ? dp[3]+'-'+dp[2]+'-'+dp[1] : '';

    // Event-Link (suche rückwärts ab dieser Stelle)
    const before = html.substring(Math.max(0, m.index - 700), m.index + 50);
    const lm = before.match(/href="(\\/party\\/\\d+[^"]{0,80}\\.html)"/);
    const link = lm ? 'https://www.joyclub.de' + lm[1] : '';

    // Teilnehmer-Stats (sichtbar wenn eingeloggt)
    const after = html.substring(m.index, m.index + 1200);
    const n = (rx) => parseInt((after.match(rx)||['','0'])[1])||0;
    events.push({
      name, datum, isoDatum, bild: imgUrl, link,
      angemeldet:      n(/>([\\d]+)<\\/[^>]+>\\s*(?:Gäste|Angemeldet)/),
      maenner:         n(/>([\\d]+)<\\/[^>]+>\\s*(?:Männer|männl)/i),
      frauen:          n(/>([\\d]+)<\\/[^>]+>\\s*(?:Frauen|weibl)/i),
      paare:           n(/>([\\d]+)<\\/[^>]+>\\s*Paare/i),
      vorgemerkt:      n(/>([\\d]+)<\\/[^>]+>\\s*Vorgemerkt/i),
      nichtBestaetigt: n(/>([\\d]+)<\\/[^>]+>\\s*(?:Unbestätigt|NichtBest)/i),
      aufrufe:         n(/>([\\d]+)<\\/[^>]+>\\s*Aufrufe/i),
    });
  }
  return events;
}

const cookieStr = $('🍪 Cookie aus NocoDB').first().json.list[0].Cookie || '';
const htmlNow   = $('🌐 Aktuelle Events').first().json.data  || '';
const htmlArch  = $('🌐 Archiv Events').first().json.data    || '';

const today = new Date(); today.setHours(0,0,0,0);

// Merge + deduplizieren
const byName = {};
[...parseJoyclubHtml(htmlNow), ...parseJoyclubHtml(htmlArch)].forEach(ev => {
  const key = ev.name.toLowerCase().trim();
  if (!byName[key] || ev.angemeldet > byName[key].angemeldet) byName[key] = ev;
});

// Status: inaktiv = vergangen
const all = Object.values(byName).map(ev => {
  const evDate = ev.isoDatum ? new Date(ev.isoDatum) : null;
  return { ...ev, status: (evDate && evDate < today) ? 'inaktiv' : 'aktiv' };
}).sort((a,b) => (b.isoDatum||'').localeCompare(a.isoDatum||''));

console.log('[Scraper] Events geparst:', all.length);
// Einzelnes Item: Liste der Events als Payload
return [{ json: { events: all, count: all.length, scrapedAt: new Date().toISOString() } }];
`;

// ── Events-API: Status-Store first, NocoDB fallback ───────────────────────────
const EVENTS_API_CODE = `
// Primär: Status-Store (live, gecacht vom Scraper)
// Fallback: NocoDB (persistent)
const storeData = $('📦 Status-Store lesen').first().json;
const nocodb    = $('📋 NocoDB Fallback').first().json;

let events = [];

if (storeData && storeData.events && storeData.events.length > 0) {
  // Status-Store hat Daten
  events = storeData.events;
  console.log('[EventsAPI] Quelle: Status-Store,', events.length, 'Events');
} else {
  // NocoDB Fallback
  const records = nocodb.list || [];
  const today = new Date(); today.setHours(0,0,0,0);
  events = records.map(ev => {
    const datumRaw = ev['EventDatum'] || '';
    const match = datumRaw.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
    const isoDatum = match ? match[3]+'-'+match[2]+'-'+match[1] : '';
    let bild = '';
    try {
      const att = ev['Event-Bild'];
      const parsed = typeof att === 'string' ? JSON.parse(att) : att;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const path = parsed[0].signedPath || parsed[0].path || parsed[0].url || '';
        bild = path.startsWith('http') ? path : 'https://nocodb.f3-events.de/' + path;
      }
    } catch(e) {}
    return {
      name: ev['EventName']||'', datum: datumRaw, isoDatum,
      status: ev['Status']||'aktiv', bild, link: ev['EventLink']||'',
      angemeldet: ev['Angemeldet']||0, maenner: ev['Maenner']||0,
      frauen: ev['Frauen']||0, paare: ev['Paare']||0,
      vorgemerkt: ev['Vorgemerkt']||0, aufrufe: ev['Aufrufe']||0,
    };
  });
  console.log('[EventsAPI] Quelle: NocoDB Fallback,', events.length, 'Events');
}

return [{ json: events }];
`;

// ── Workflow 1: Scraper ───────────────────────────────────────────────────────
const scraperWorkflow = {
  name: "F3 JOYclub Events Scraper",
  nodes: [
    {
      id: "n-webhook", name: "🚀 Webhook: Events scrapen",
      type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 200],
      parameters: { httpMethod: "GET", path: "f3-events-scraper", responseMode: "responseNode", options: {} }
    },
    {
      id: "n-schedule", name: "⏰ Schedule: Täglich 05:00",
      type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1, position: [0, 400],
      parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 5 * * *" }] } }
    },
    {
      id: "n-cookie", name: "🍪 Cookie aus NocoDB",
      type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [220, 300],
      parameters: {
        method: "GET",
        url: `${NOCODB_URL}/api/v1/db/data/noco/${PROJECT_ID}/${COOKIES_TBL}?limit=1`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: "xc-token", value: NOCODB_TOK }] },
        options: {}
      }
    },
    {
      id: "n-current", name: "🌐 Aktuelle Events",
      type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [440, 200],
      parameters: {
        method: "GET",
        url: "https://www.joyclub.de/party/veranstaltungen/13140845.f3.html",
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: "Cookie",     value: "={{ $('🍪 Cookie aus NocoDB').first().json.list[0].Cookie }}" },
          { name: "User-Agent", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36" },
          { name: "Accept",     value: "text/html,application/xhtml+xml" },
          { name: "Accept-Language", value: "de-DE,de;q=0.9" }
        ]},
        options: { response: { response: { responseFormat: "text" } } }
      }
    },
    {
      id: "n-archive", name: "🌐 Archiv Events",
      type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [440, 400],
      parameters: {
        method: "GET",
        url: "https://www.joyclub.de/party/veranstaltungen/13140845-archive.f3.html",
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: "Cookie",     value: "={{ $('🍪 Cookie aus NocoDB').first().json.list[0].Cookie }}" },
          { name: "User-Agent", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36" },
          { name: "Accept",     value: "text/html,application/xhtml+xml" },
          { name: "Accept-Language", value: "de-DE,de;q=0.9" }
        ]},
        options: { response: { response: { responseFormat: "text" } } }
      }
    },
    {
      id: "n-merge", name: "🔀 Merge: Beide Seiten",
      type: "n8n-nodes-base.merge", typeVersion: 3, position: [660, 300],
      parameters: { mode: "append", options: {} }
    },
    {
      id: "n-parse", name: "⚙️ Code: Events parsen",
      type: "n8n-nodes-base.code", typeVersion: 2, position: [880, 300],
      parameters: { jsCode: PARSE_CODE }
    },
    {
      id: "n-save", name: "💾 Status-Store: Events speichern",
      type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [1100, 300],
      parameters: {
        method: "POST",
        url: STATUS_URL,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: "Content-Type", value: "application/json" }] },
        sendBody: true,
        specifyBody: "json",
        jsonBody: '={{ JSON.stringify({ key: "joyclub-events", data: $json }) }}',
        options: {}
      }
    },
    {
      id: "n-respond", name: "✅ Respond: Fertig",
      type: "n8n-nodes-base.respondToWebhook", typeVersion: 1, position: [1320, 300],
      parameters: {
        respondWith: "json",
        responseBody: '={{ JSON.stringify({ ok: true, count: $("⚙️ Code: Events parsen").first().json.count, scrapedAt: $("⚙️ Code: Events parsen").first().json.scrapedAt }) }}',
        options: {}
      }
    }
  ],
  connections: {
    "🚀 Webhook: Events scrapen": { main: [[{ node: "🍪 Cookie aus NocoDB", index: 0 }]] },
    "⏰ Schedule: Täglich 05:00":  { main: [[{ node: "🍪 Cookie aus NocoDB", index: 0 }]] },
    "🍪 Cookie aus NocoDB":        { main: [[{ node: "🌐 Aktuelle Events", index: 0 }, { node: "🌐 Archiv Events", index: 0 }]] },
    "🌐 Aktuelle Events":          { main: [[{ node: "🔀 Merge: Beide Seiten", index: 0 }]] },
    "🌐 Archiv Events":            { main: [[{ node: "🔀 Merge: Beide Seiten", index: 1 }]] },
    "🔀 Merge: Beide Seiten":      { main: [[{ node: "⚙️ Code: Events parsen", index: 0 }]] },
    "⚙️ Code: Events parsen":      { main: [[{ node: "💾 Status-Store: Events speichern", index: 0 }]] },
    "💾 Status-Store: Events speichern": { main: [[{ node: "✅ Respond: Fertig", index: 0 }]] },
  },
  settings: { executionOrder: "v1" },
  staticData: null
};

// ── Workflow 2: Events API aktualisieren ──────────────────────────────────────
// Liest bestehende Events-API, tauscht NocoDB-Node gegen Status-Store-first aus

// ── API-Hilfsfunktion ─────────────────────────────────────────────────────────
function n8nRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: N8N_HOST, path, method,
      headers: {
        'X-N8N-API-KEY': N8N_KEY,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  try {
    // ── 1. Scraper-Workflow erstellen ─────────────────────────────────────────
    console.log('\n=== Erstelle Scraper-Workflow ===');
    const scraper = await n8nRequest('POST', '/api/v1/workflows', scraperWorkflow);
    if (!scraper.id) { console.error('✗ Fehler Scraper:', JSON.stringify(scraper).substring(0,300)); process.exit(1); }
    console.log('✓ Scraper erstellt | ID:', scraper.id);
    await n8nRequest('POST', `/api/v1/workflows/${scraper.id}/activate`, {});
    console.log('✓ Scraper aktiviert');

    // ── 2. Events-API Workflow patchen ────────────────────────────────────────
    console.log('\n=== Patche Events-API Workflow ===');
    // Events-API Workflow suchen
    const wfList = await n8nRequest('GET', '/api/v1/workflows?limit=50', null);
    const eventsApiWf = (wfList.data||[]).find(w => w.name === 'F3 Events API');
    if (!eventsApiWf) { console.warn('⚠ Events-API Workflow nicht gefunden – manuell prüfen'); }
    else {
      const evApi = await n8nRequest('GET', `/api/v1/workflows/${eventsApiWf.id}`, null);

      // Status-Store-Leseanfrage hinzufügen
      const storeNode = {
        id: "n-store-read", name: "📦 Status-Store lesen",
        type: "n8n-nodes-base.httpRequest", typeVersion: 4, position: [220, 0],
        parameters: {
          method: "GET",
          url: "http://f3-cookie-crawler:3000/status/joyclub-events",
          options: {}
        }
      };
      // NocoDB Fallback umbenennen
      const nocoNode = evApi.nodes.find(n => n.name === 'NocoDB: Events holen');
      if (nocoNode) nocoNode.name = '📋 NocoDB Fallback';

      // Code-Node für Status-Store-first-Logik
      const logicNode = {
        id: "n-store-logic", name: "⚙️ Status-Store first",
        type: "n8n-nodes-base.code", typeVersion: 2, position: [440, 0],
        parameters: { jsCode: EVENTS_API_CODE }
      };

      // Webhook und Respond-Node finden
      const webhookNode = evApi.nodes.find(n => n.type.includes('webhook') && !n.type.includes('respond'));
      const respondNode = evApi.nodes.find(n => n.type.includes('respondToWebhook'));
      const formatNode  = evApi.nodes.find(n => n.name === 'Events formatieren');

      // Alte Format-Node entfernen (Logik jetzt im neuen Code-Node)
      evApi.nodes = evApi.nodes.filter(n => n.name !== 'Events formatieren');

      // Neue Nodes hinzufügen
      evApi.nodes.push(storeNode, logicNode);

      // Verbindungen neu aufbauen
      if (webhookNode && nocoNode) {
        evApi.connections[webhookNode.name] = { main: [[
          { node: "📦 Status-Store lesen", index: 0 },
          { node: nocoNode.name, index: 0 }
        ]]};
        evApi.connections["📦 Status-Store lesen"] = { main: [[{ node: "⚙️ Status-Store first", index: 0 }]] };
        evApi.connections[nocoNode.name] = { main: [[{ node: "⚙️ Status-Store first", index: 0 }]] };
        if (respondNode) {
          evApi.connections["⚙️ Status-Store first"] = { main: [[{ node: respondNode.name, index: 0 }]] };
        }
      }

      const putResult = await n8nRequest('PUT', `/api/v1/workflows/${eventsApiWf.id}`, {
        name: evApi.name, nodes: evApi.nodes, connections: evApi.connections,
        settings: { executionOrder: evApi.settings?.executionOrder, callerPolicy: evApi.settings?.callerPolicy },
        staticData: null
      });
      if (putResult.id) {
        console.log('✓ Events-API aktualisiert | Status-Store first, NocoDB Fallback');
        await n8nRequest('POST', `/api/v1/workflows/${eventsApiWf.id}/activate`, {});
        console.log('✓ Events-API reaktiviert');
      } else {
        console.error('✗ Events-API PUT Fehler:', JSON.stringify(putResult).substring(0,300));
      }
    }

    console.log('\n✅ Fertig!');
    console.log('Scraper Webhook: https://n8n.f3-events.de/webhook/f3-events-scraper');
    console.log('Jetzt testen: curl https://n8n.f3-events.de/webhook/f3-events-scraper');

  } catch(e) {
    console.error('✗ Exception:', e.message, e.stack);
  }
})();
