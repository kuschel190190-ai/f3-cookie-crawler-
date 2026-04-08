'use strict';
// Fixes F3|2 Event Details scrapen 404 errors by switching from
// /edit/event/ (management page, only ticket_management URLs) to
// public organizer page (has proper .html URLs for stats scraping)

const https = require('https');
const fs = require('fs');

const N8N_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const BASE = 'https://n8n.f3-events.de/api/v1';
const WF_ID = 'VHQhES7qOfTyn4FQ';

// Public organizer page URL – has proper .html event URLs
const JOYCLUB_PUBLIC_URL = 'https://www.joyclub.de/party/veranstaltungen/13140845.f3.html';

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

// New HTML parsen: handles public organizer page structure
// <li data-day="DD.MM.YYYY"> for dates
// <li id="event_XXXXX"> for events with .html URLs
const NEW_HTML_PARSEN = `const html = $input.first().json.data || $input.first().json;
const htmlStr = typeof html === 'string' ? html : JSON.stringify(html);
const results = [];
let currentDate = '';
let currentIsoDatum = '';

// Public page structure: <li data-day="DD.MM.YYYY"> then <li id="event_XXXXX">
const parts = htmlStr.split('<li');
for (const part of parts) {
  // Date header: data-day="04.04.2026"
  const dayM = part.match(/\\s+data-day="(\\d{2})\\.(\\d{2})\\.(\\d{4})"/);
  if (dayM) {
    currentDate = dayM[1] + '.' + dayM[2] + '.' + dayM[3];
    currentIsoDatum = dayM[3] + '-' + dayM[2] + '-' + dayM[1];
    continue;
  }

  // Event item: id="event_1829501"
  const idM = part.match(/\\sid="event_(\\d+)"/);
  if (!idM || !currentDate) continue;

  // Skip cancelled events
  if (part.includes('Abgesagt') || part.includes('abgesagt')) continue;

  // Get .html event URL (public event page)
  const urlM = part.match(/href="(https:\\/\\/www\\.joyclub\\.de\\/event\\/[^"]+\\.html)"/);
  if (!urlM) continue;

  // Get event name from h2.event_name
  const nameContM = part.match(/class="h_2 event_name"[^>]*>([\\s\\S]*?)<\\/h2>/);
  let EventName = nameContM ? nameContM[1].replace(/<[^>]+>/g, '').trim() : '';
  if (!EventName) continue;

  results.push({ json: { EventName, EventDatum: currentDate, isoDatum: currentIsoDatum, EventLink: urlM[1].split('#')[0] } });
}

return results.length > 0 ? results : [{ json: { error: 'Keine Events gefunden', htmlLength: htmlStr.length } }];`;

// Simplified Event Details scrapen: URLs are now always .html, no conversion needed
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

  // 1. Update Joyclub fetch URL to public organizer page
  const joyNode = wf.nodes.find(n => n.name === 'Joyclub Events-Seite abrufen');
  if (joyNode) {
    const oldUrl = joyNode.parameters.url;
    joyNode.parameters.url = JOYCLUB_PUBLIC_URL;
    console.log('Joyclub URL:', oldUrl, '→', JOYCLUB_PUBLIC_URL);
  } else {
    console.log('⚠ Joyclub fetch node not found. Nodes:', wf.nodes.map(n => n.name).join(', '));
  }

  // 2. Update HTML parsen
  const htmlNode = wf.nodes.find(n => n.name === 'HTML parsen');
  if (htmlNode) { htmlNode.parameters.jsCode = NEW_HTML_PARSEN; console.log('HTML parsen updated ✓'); }
  else console.log('⚠ HTML parsen node not found');

  // 3. Update Event Details scrapen
  const detailNode = wf.nodes.find(n => n.name === 'Event Details scrapen');
  if (detailNode) { detailNode.parameters.jsCode = NEW_DETAIL_CODE; console.log('Event Details scrapen updated ✓'); }
  else console.log('⚠ Event Details scrapen node not found');

  // 4. Save
  const put = await req('PUT', BASE + '/workflows/' + WF_ID, {
    name: wf.name, nodes: wf.nodes, connections: wf.connections,
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
    staticData: wf.staticData || null
  });

  if (put.status === 200) {
    console.log('✓ F3|2 saved | versionId:', put.body.versionId?.substring(0, 8));
    fs.writeFileSync('f3-automation/n8n/2-event-teilnehmer-sync.json', JSON.stringify(put.body, null, 2));
    console.log('✓ JSON synced locally');
  } else {
    console.error('PUT failed:', put.status, JSON.stringify(put.body).substring(0, 300));
  }
}

main().catch(console.error);
