'use strict';
// Adds cancelled-event detection to Event Details scrapen:
// If the event page shows "Abgesagt", Status is set to 'abgesagt' in DB (skips stats)
// The public organizer page doesn't mark cancelled events in HTML, so we detect on the event page itself.

const https = require('https');
const fs = require('fs');

const N8N_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const BASE = 'https://n8n.f3-events.de/api/v1';
const WF_ID = 'VHQhES7qOfTyn4FQ';

function req(method, url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = data ? Buffer.from(JSON.stringify(data), 'utf8') : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname, method,
      headers: { 'X-N8N-API-KEY': N8N_KEY, 'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': body.length } : {}) }
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString()) }); }
        catch { resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const NEW_DETAIL_CODE = `const cookie = $('Cookies holen').first().json.cookieString || '';
const toInt = str => str ? parseInt(str.replace(/[^\\d]/g, ''), 10) : 0;

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
        Accept: 'text/html',
        'Accept-Language': 'de-DE,de;q=0.9'
      },
      timeout: 20000,
      followRedirects: true
    });
    html = typeof resp === 'string' ? resp : JSON.stringify(resp);
  } catch(e) {
    console.log('Fetch error Event ' + Id + ':', e.message);
    results.push({ json: { Id, status: 'fetch_error', error: e.message } });
    continue;
  }

  // Detect cancelled events: JOYclub shows "Abgesagt" as a CSS class or header on the event page
  const isAbgesagt = html.match(/class="[^"]*abgesagt[^"]*"/) ||
                     html.match(/>\\s*Abgesagt\\s*</) ||
                     html.match(/Dieses Event[^<]*abgesagt/i) ||
                     html.match(/event[_-]cancelled/i);
  if (isAbgesagt) {
    try {
      await this.helpers.httpRequest({
        method: 'PATCH',
        url: 'http://f3-cookie-crawler:3000/api/events/' + Id,
        headers: { 'Content-Type': 'application/json' },
        body: { Status: 'abgesagt' },
        json: true
      });
    } catch(e) {}
    results.push({ json: { Id, status: 'abgesagt' } });
    console.log('Event ' + Id + ': ABGESAGT');
    continue;
  }

  console.log('HTML length:', html.length);
  const angemeldetM  = html.match(/(\\d+)\\s*Personen angemeldet/);
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

  // EventBild aus JOYclub CDN (nur wenn noch nicht gesetzt)
  if (!event.EventBild) {
    const imgM = html.match(/data-overlay-image-ui-data="([^"]+)"/);
    if (imgM) {
      const dec = imgM[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/\\\\\\//g,'/');
      try {
        const d = JSON.parse(dec);
        const srcs = (d.fallback_image_source_set||{}).source_list||[];
        const best = srcs.find(s=>s.width>=800)||srcs[srcs.length-1];
        if (best&&best.resource_path) patch.EventBild = best.resource_path;
      } catch(e) {}
    }
  }

  // Event-Beschreibung
  const descM = html.match(/class="event_description brkwrd"[^>]*>([\\s\\S]*?)(?=<div class="[^"]*event_detail_tab|<div id="guest_list|<div class="clearfix[^"]*">\\s*<\\/div>)/);
  if (descM) {
    let raw = descM[1].replace(/<div[^>]*image-ui[^>]*>[\\s\\S]*?<\\/div>/g,'');
    const text = raw.replace(/<[^>]+>/g,' ').replace(/&[^;]+;/g,' ').replace(/\\s+/g,' ').trim();
    if (text.length > 20) patch['Event-Beschreibung'] = text.substring(0,1000);
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
    console.log('Event ' + Id + ': Angemeldet=' + patch.Angemeldet + ' Aufrufe=' + patch.Aufrufe);
  } catch(e) {
    results.push({ json: { Id, status: 'patch_error', error: e.message } });
  }
}

// Status Store
try {
  const all = await this.helpers.httpRequest({ method:'GET', url:'http://f3-cookie-crawler:3000/api/events?status=aktiv' });
  await this.helpers.httpRequest({
    method:'POST', url:'http://f3-cookie-crawler:3000/status',
    headers:{'Content-Type':'application/json'},
    body:{ key:'events', data:{ events: all.list||[], updatedAt: new Date().toISOString() } }, json:true
  });
} catch(e) {}

return results;`;

async function main() {
  console.log('── Fetching F3|2 ──');
  const r = await req('GET', BASE + '/workflows/' + WF_ID);
  if (r.status !== 200) { console.error('Fetch failed:', r.body); return; }
  const wf = r.body;

  const detailNode = wf.nodes.find(n => n.name === 'Event Details scrapen');
  if (!detailNode) { console.error('Node not found'); return; }
  detailNode.parameters.jsCode = NEW_DETAIL_CODE;
  console.log('Event Details scrapen updated ✓');

  const put = await req('PUT', BASE + '/workflows/' + WF_ID, {
    name: wf.name, nodes: wf.nodes, connections: wf.connections,
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
    staticData: wf.staticData || null
  });

  if (put.status === 200) {
    console.log('✓ F3|2 saved | versionId:', put.body.versionId?.substring(0, 8));
    fs.writeFileSync('f3-automation/n8n/2-event-teilnehmer-sync.json', JSON.stringify(put.body, null, 2));
    console.log('✓ JSON synced');
  } else {
    console.error('PUT failed:', put.status, JSON.stringify(put.body).substring(0, 300));
  }
}

main().catch(console.error);
