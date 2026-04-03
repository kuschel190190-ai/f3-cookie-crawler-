// Merges 2a + 2b into one workflow:
// - Fresh cookies via /cookies (not /api/cookies)
// - Syncs event list from JOYclub edit page (2a logic)
// - Scrapes details: Teilnehmer, EventBild (JOYclub CDN), Event-Beschreibung (2b logic)
// - Updates F3|1 to call merged workflow only (removes 2b call)
// - Deactivates 2b
'use strict';
const https = require('https');

const N8N_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const BASE = 'https://n8n.f3-events.de/api/v1';
const ID_2A = 'VHQhES7qOfTyn4FQ';
const ID_2B = 'NvPR3b3Dxl0l50zT';
const ID_1  = 'fgHKrok4oZYaYBry';

function req(method, url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = data ? Buffer.from(JSON.stringify(data), 'utf8') : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'X-N8N-API-KEY': N8N_KEY, 'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const DETAIL_SCRAPER_CODE = `const cookie = $('Cookies holen').first().json.cookieString || '';
const toInt = str => str ? parseInt(str.replace(/[^\\d]/g, ''), 10) : 0;

// Get all active events from DB
const eventsResp = await this.helpers.httpRequest({
  method: 'GET',
  url: 'http://f3-cookie-crawler:3000/api/events?status=aktiv'
});
const events = eventsResp.list || [];
const results = [];

for (const event of events) {
  const { Id, EventLink } = event;
  if (!EventLink) continue;
  console.log('Scraping Event ' + Id + ': ' + EventLink);

  let html = '';
  try {
    const resp = await this.helpers.httpRequest({
      method: 'GET',
      url: EventLink,
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        Accept: 'text/html'
      },
      timeout: 20000
    });
    html = typeof resp === 'string' ? resp : JSON.stringify(resp);
  } catch(e) {
    console.log('Fetch error Event ' + Id + ':', e.message);
    results.push({ json: { Id, status: 'fetch_error', error: e.message } });
    continue;
  }

  const angemeldetM  = html.match(/(\\d+)\\s*Personen angemeldet/)  || html.match(/>(\\d+)<[^>]*>\\s*Personen angemeldet/);
  const nichtBestM   = html.match(/(\\d+)\\s*noch nicht best.tigt/) || html.match(/(\\d+)\\s*nicht best.tigt/);
  const vorgemerktM  = html.match(/(\\d+)\\s*mal vorgemerkt/);
  const aufrufM      = html.match(/(\\d+)\\s*Aufrufe/);
  const maennerM     = html.match(/M.nner[^(]*\\((\\d+)\\)/);
  const frauenM      = html.match(/Frauen[^(]*\\((\\d+)\\)/);
  const paareM       = html.match(/Paare[^(]*\\((\\d+)\\)/);

  const patch = {
    Angemeldet:      angemeldetM  ? toInt(angemeldetM[1])  : 0,
    NichtBestaetigt: nichtBestM   ? toInt(nichtBestM[1])   : 0,
    Vorgemerkt:      vorgemerktM  ? toInt(vorgemerktM[1])  : 0,
    Aufrufe:         aufrufM      ? toInt(aufrufM[1])      : 0,
    Maenner:         maennerM     ? toInt(maennerM[1])     : 0,
    Frauen:          frauenM      ? toInt(frauenM[1])      : 0,
    Paare:           paareM       ? toInt(paareM[1])       : 0
  };

  // EventBild aus JOYclub CDN (nur setzen wenn noch nicht vorhanden)
  if (!event.EventBild) {
    const imgAttrM = html.match(/data-overlay-image-ui-data="([^"]+)"/);
    if (imgAttrM) {
      const decoded = imgAttrM[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\\\\\//g, '/');
      try {
        const imgData = JSON.parse(decoded);
        const sources = (imgData.fallback_image_source_set || {}).source_list || [];
        const best = sources.find(s => s.width >= 800) || sources[sources.length - 1];
        if (best && best.resource_path) patch.EventBild = best.resource_path;
      } catch(e) { console.log('Image parse error:', e.message); }
    }
  }

  // Event-Beschreibung
  const descM = html.match(/class="event_description brkwrd"[^>]*>([\\s\\S]*?)(?=<div class="[^"]*event_detail_tab|<div id="guest_list|<\\/div>\\s*<\\/div>\\s*<div class="clearfix)/);
  if (descM) {
    let raw = descM[1].replace(/<div[^>]*image-ui[^>]*>[\\s\\S]*?<\\/div>/g, '');
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\\s+/g, ' ').trim();
    if (text.length > 20) patch['Event-Beschreibung'] = text.substring(0, 1000);
  }

  try {
    await this.helpers.httpRequest({
      method: 'PATCH',
      url: 'http://f3-cookie-crawler:3000/api/events/' + Id,
      headers: { 'Content-Type': 'application/json' },
      body: patch,
      json: true
    });
    results.push({ json: { Id, status: 'ok', ...patch } });
    console.log('Event ' + Id + ' OK | Angemeldet=' + patch.Angemeldet + ' | Bild=' + (patch.EventBild?'✓':'–'));
  } catch(e) {
    results.push({ json: { Id, status: 'patch_error', error: e.message } });
  }
}

// Dashboard Status Store aktualisieren
try {
  const allResp = await this.helpers.httpRequest({ method: 'GET', url: 'http://f3-cookie-crawler:3000/api/events?status=aktiv' });
  await this.helpers.httpRequest({
    method: 'POST',
    url: 'http://f3-cookie-crawler:3000/status',
    headers: { 'Content-Type': 'application/json' },
    body: { key: 'events', data: { events: allResp.list || [], updatedAt: new Date().toISOString() } },
    json: true
  });
} catch(e) { console.log('Status store error:', e.message); }

return results;`;

async function main() {
  // 1. Fetch current 2a workflow
  console.log('\n── Fetching 2a workflow ──');
  const r2a = await req('GET', `${BASE}/workflows/${ID_2A}`);
  if (r2a.status !== 200) { console.error('Failed:', r2a.body); return; }
  const wf2a = r2a.body;
  console.log('2a:', wf2a.name, '| versionId:', wf2a.versionId);

  // 2. Modify 2a
  // a. Change name
  wf2a.name = 'F3 | 2 – Event + Teilnehmer Sync [Sync]';

  // b. Change Cookies holen URL from /api/cookies to /cookies
  const cookiesNode = wf2a.nodes.find(n => n.name === 'Cookies holen');
  if (cookiesNode) {
    cookiesNode.parameters.url = 'http://f3-cookie-crawler:3000/cookies';
    console.log('Cookies holen URL updated to /cookies');
  }

  // c. Change cookie header in Joyclub Events-Seite abrufen
  const joyNode = wf2a.nodes.find(n => n.name === 'Joyclub Events-Seite abrufen');
  if (joyNode) {
    const params = joyNode.parameters.headerParameters?.parameters || [];
    const cookieParam = params.find(p => p.name === 'Cookie');
    if (cookieParam) {
      cookieParam.value = '={{ $json.cookieString }}';
      console.log('Joyclub cookie header updated to $json.cookieString');
    }
  }

  // d. Add "Event Details scrapen" Code node after all DB: Create/Update/Deaktivieren nodes
  const detailNode = {
    parameters: { jsCode: DETAIL_SCRAPER_CODE, mode: 'runOnceForAllItems' },
    id: 'detail-scraper-2ab-001',
    name: 'Event Details scrapen',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [480, 720]
  };
  wf2a.nodes.push(detailNode);

  // e. Add Telegram: Erfolg after detail scraping (update existing)
  const telegramSucc = wf2a.nodes.find(n => n.name === 'Telegram: Erfolg');
  if (telegramSucc) {
    telegramSucc.position = [720, 720];
    telegramSucc.parameters.text = '=✅ Event + Teilnehmer Sync abgeschlossen!\n\n➕ Neu: {{ $input.all().filter(i => i.json.status === \'ok\' && i.json.Angemeldet !== undefined).length }} Events mit Stats\n🕐 {{ new Date().toLocaleTimeString(\'de-DE\') }}';
  }

  // f. Connect: DB nodes → Event Details scrapen → Telegram: Erfolg
  // Remove old Telegram: Erfolg connection from Vergleichen
  if (wf2a.connections['Vergleichen']) {
    wf2a.connections['Vergleichen'].main[0] = wf2a.connections['Vergleichen'].main[0]
      .filter(c => c.node !== 'Telegram: Erfolg');
  }

  // Add connections from all DB nodes to Event Details scrapen
  for (const dbNode of ['DB: Create', 'DB: Update', 'DB: Deaktivieren']) {
    if (!wf2a.connections[dbNode]) wf2a.connections[dbNode] = { main: [[]] };
    const existing = wf2a.connections[dbNode].main[0] || [];
    if (!existing.find(c => c.node === 'Event Details scrapen')) {
      existing.push({ node: 'Event Details scrapen', type: 'main', index: 0 });
    }
    wf2a.connections[dbNode].main[0] = existing;
  }

  // Also connect directly from Vergleichen (in case no DB action needed)
  if (wf2a.connections['Vergleichen']) {
    const existingVgl = wf2a.connections['Vergleichen'].main[0] || [];
    if (!existingVgl.find(c => c.node === 'Event Details scrapen')) {
      existingVgl.push({ node: 'Event Details scrapen', type: 'main', index: 0 });
    }
  }

  // Connect Event Details scrapen → Telegram: Erfolg
  wf2a.connections['Event Details scrapen'] = {
    main: [[{ node: 'Telegram: Erfolg', type: 'main', index: 0 }]]
  };

  // 3. PUT merged 2a back
  console.log('\n── Pushing merged 2ab workflow ──');
  const payload2a = {
    name: wf2a.name,
    nodes: wf2a.nodes,
    connections: wf2a.connections,
    settings: { executionOrder: 'v1', callerPolicy: wf2a.settings?.callerPolicy || 'workflowsFromSameOwner' },
    staticData: wf2a.staticData || null
  };
  const put2a = await req('PUT', `${BASE}/workflows/${ID_2A}`, payload2a);
  if (put2a.status === 200) {
    console.log('✓ 2ab saved | versionId:', put2a.body.versionId);
  } else {
    console.error('PUT 2a failed:', put2a.status, JSON.stringify(put2a.body).substring(0,300));
    return;
  }

  // 4. Update F3|1 to remove 2b call
  console.log('\n── Updating F3|1 (remove 2b call) ──');
  const r1 = await req('GET', `${BASE}/workflows/${ID_1}`);
  if (r1.status !== 200) { console.error('Failed to fetch F3|1:', r1.body); return; }
  const wf1 = r1.body;

  // Remove the "2b Teilnehmer-Sync starten" node
  wf1.nodes = wf1.nodes.filter(n => !n.name.includes('2b'));
  // Remove from connections
  for (const key of Object.keys(wf1.connections)) {
    for (const main of wf1.connections[key].main || []) {
      const idx = main.findIndex(c => c.node && c.node.includes('2b'));
      if (idx > -1) main.splice(idx, 1);
    }
  }
  delete wf1.connections['2b Teilnehmer-Sync starten'];
  console.log('Removed 2b from F3|1');

  const payload1 = {
    name: wf1.name,
    nodes: wf1.nodes,
    connections: wf1.connections,
    settings: { executionOrder: 'v1', callerPolicy: wf1.settings?.callerPolicy || 'workflowsFromSameOwner' },
    staticData: wf1.staticData || null
  };
  const put1 = await req('PUT', `${BASE}/workflows/${ID_1}`, payload1);
  if (put1.status === 200) {
    console.log('✓ F3|1 saved | versionId:', put1.body.versionId);
  } else {
    console.error('PUT F3|1 failed:', put1.status, JSON.stringify(put1.body).substring(0,300));
  }

  // 5. Deactivate 2b
  console.log('\n── Deactivating 2b ──');
  const deact = await req('POST', `${BASE}/workflows/${ID_2B}/deactivate`);
  console.log('Deactivate 2b:', deact.status, deact.status === 200 ? '✓' : JSON.stringify(deact.body));

  console.log('\n✅ Done.');
}

main().catch(console.error);
