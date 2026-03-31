// patch_events_api.js – Repariert F3 Events API Workflow
const https = require('https');

const N8N_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const WF_ID  = '9NmBa2Jq6KUsODOb';

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

(async () => {
  console.log('1. Workflow holen...');
  const res = await apiGet(`/api/v1/workflows/${WF_ID}`);
  const wf = JSON.parse(res.body);
  console.log('   Nodes:', wf.nodes.map(n => n.name).join(', '));

  // Code node reparieren: nur Status-Store, kein NocoDB-Zugriff
  const codeNode = wf.nodes.find(n => n.name.includes('Status-Store first'));
  if (!codeNode) throw new Error('Code node nicht gefunden!');

  codeNode.parameters.jsCode = `// Status-Store Primärquelle
const storeData = $('📦 Status-Store lesen').first().json;
const events = (storeData && storeData.events && storeData.events.length > 0)
  ? storeData.events
  : [];
console.log('[EventsAPI] Status-Store:', events.length, 'Events');
return [{ json: { _response: JSON.stringify(events) } }];`;

  console.log('   Code node aktualisiert');

  // Respond node: JSON-String direkt als Text-Body senden
  const respondNode = wf.nodes.find(n => n.name === 'Antwort senden');
  if (respondNode) {
    respondNode.parameters.respondWith = 'text';
    respondNode.parameters.responseBody = '={{ $json._response }}';
    respondNode.parameters.options = {};
    console.log('   Respond node aktualisiert');
  }

  // Verbindung Webhook → NocoDB Fallback entfernen
  const webhookConns = wf.connections['Webhook'];
  if (webhookConns && webhookConns.main) {
    webhookConns.main = webhookConns.main.map(branch =>
      branch.filter(c => c.node !== '📋 NocoDB Fallback')
    );
    console.log('   Webhook → NocoDB Fallback Verbindung entfernt');
  }
  // Alle alten/störenden Verbindungen entfernen die zu Antwort senden führen (außer neue)
  delete wf.connections['📋 NocoDB Fallback'];
  delete wf.connections['Events formatieren'];
  delete wf.connections['NocoDB: Events holen'];
  console.log('   Alte Verbindungen bereinigt');
  console.log('   Aktuelle connections:', Object.keys(wf.connections).join(', '));

  // 2. Workflow zurückschreiben
  console.log('2. Workflow zurückschreiben...');
  const { executionOrder, errorWorkflow, callerPolicy } = wf.settings || {};
  const putRes = await apiPut(`/api/v1/workflows/${WF_ID}`, {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: { executionOrder, errorWorkflow, callerPolicy },
    staticData: wf.staticData || null
  });
  console.log('   PUT HTTP', putRes.status);
  if (putRes.status !== 200) console.log('   Fehler:', putRes.body.substring(0, 200));

  // 3. Reaktivieren
  console.log('3. Reaktivieren...');
  const actRes = await apiPost(`/api/v1/workflows/${WF_ID}/activate`);
  console.log('   HTTP', actRes.status);

  // 4. Testen
  console.log('4. Webhook testen...');
  await new Promise(r => setTimeout(r, 1000));
  const testRes = await new Promise((resolve, reject) => {
    const u = new URL('https://n8n.f3-events.de/webhook/f3-events-api');
    https.get({ hostname: u.hostname, path: u.pathname }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
  console.log('   HTTP', testRes.status, '| Body:', testRes.body.substring(0, 200));
  try {
    const parsed = JSON.parse(testRes.body);
    console.log('   Events:', Array.isArray(parsed) ? parsed.length : JSON.stringify(parsed).substring(0, 100));
  } catch(e) {
    console.log('   Kein JSON:', e.message);
  }

  console.log('\nFertig!');
})().catch(e => console.error('Fehler:', e.message));
