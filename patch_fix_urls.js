'use strict';
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

// Fix 1: HTML parsen – prefer .html public URL over ticket_management
const NEW_HTML_PARSEN = `const html = $input.first().json.data || $input.first().json;
const htmlStr = typeof html === 'string' ? html : JSON.stringify(html);
const anchorRegex = /<a\\s[^>]*class="[^"]*event-list-entry[^"]*"[^>]*>[\\s\\S]*?<\\/a>/g;
const nameRegex = /class="inner ellipsis headline-status"[^>]*title="([^"]+)"/;
const dateRegex = /class="ela-date[^"]*">([^<]+)<\\/span>/;
const results = [];
let match;
while ((match = anchorRegex.exec(htmlStr)) !== null) {
  const block = match[0];
  if (block.includes('>Abgesagt<')) continue;

  // Prefer public .html URL, fall back to ticket_management
  const htmlUrlMatch = block.match(/href="(https:\\/\\/www\\.joyclub\\.de\\/event\\/\\d+\\.[^"]+\\.html)"/);
  const mgmtUrlMatch = block.match(/href="(https:\\/\\/www\\.joyclub\\.de\\/event\\/(\\d+)\\/[^"]+)"/);
  let link = '';
  if (htmlUrlMatch) {
    link = htmlUrlMatch[1];
  } else if (mgmtUrlMatch) {
    // Convert ticket_management to base redirect URL
    link = 'https://www.joyclub.de/event/' + mgmtUrlMatch[2] + '/';
  }
  if (!link) continue;

  const nameMatch = nameRegex.exec(block);
  const dateMatch = dateRegex.exec(block);
  const rawName = nameMatch ? nameMatch[1] : '';
  const rawDate = dateMatch ? dateMatch[1].trim() : '';
  const datum = rawDate.replace(/^\\w+\\.?,?\\s*/, '').trim();
  let isoDatum = '';
  const dm = datum.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
  if (dm) isoDatum = dm[3] + '-' + dm[2] + '-' + dm[1];
  if (rawName && datum) results.push({ json: { EventName: rawName, EventDatum: datum, isoDatum, EventLink: link } });
}
return results.length > 0 ? results : [{ json: { error: 'Keine Events gefunden', htmlLength: htmlStr.length } }];`;

// Fix 2: Event Details scrapen – convert ticket_management URLs to public URL via redirect
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

  // Convert ticket_management URL to base event URL (JOYclub redirects to public page)
  let fetchUrl = EventLink;
  if (EventLink.includes('ticket_management')) {
    const idM = EventLink.match(/\\/event\\/(\\d+)\\//);
    if (idM) fetchUrl = 'https://www.joyclub.de/event/' + idM[1] + '/';
  }
  console.log('Scraping Event ' + Id + ': ' + fetchUrl);

  let html = '';
  try {
    const resp = await this.helpers.httpRequest({
      method: 'GET',
      url: fetchUrl,
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

  // Event-Beschreibung (Text nach dem Bild-Div)
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

  // Patch HTML parsen
  const htmlNode = wf.nodes.find(n => n.name === 'HTML parsen');
  if (htmlNode) { htmlNode.parameters.jsCode = NEW_HTML_PARSEN; console.log('HTML parsen updated ✓'); }

  // Patch Event Details scrapen
  const detailNode = wf.nodes.find(n => n.name === 'Event Details scrapen');
  if (detailNode) { detailNode.parameters.jsCode = NEW_DETAIL_CODE; console.log('Event Details scrapen updated ✓'); }

  const put = await req('PUT', BASE + '/workflows/' + WF_ID, {
    name: wf.name, nodes: wf.nodes, connections: wf.connections,
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
    staticData: wf.staticData || null
  });

  if (put.status === 200) {
    console.log('✓ F3|2 saved | versionId:', put.body.versionId?.substring(0, 8));
    // Save locally
    fs.writeFileSync('f3-automation/n8n/2-event-teilnehmer-sync.json', JSON.stringify(put.body, null, 2));
    console.log('✓ JSON synced');
  } else {
    console.error('PUT failed:', put.status, JSON.stringify(put.body).substring(0, 300));
  }
}

main().catch(console.error);
