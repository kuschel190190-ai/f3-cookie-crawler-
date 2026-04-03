// Patches ✅ Event & Bild prüfen1 + populates EventBild for 3 events
const https = require('https');

const N8N_BASE = 'https://n8n.f3-events.de/api/v1';
const N8N_KEY  = process.env.N8N_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const COOKIE_CRAWLER = 'https://dashboard.f3-events.de';

function request(method, url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const NEW_CODE = `const isMontag = $('✅ Cookie prüfen1').item.json.isMontag;
const event = $input.item.json;

if (!event || !event.EventName) {
  throw new Error('Kein aktives Event für heute! NocoDB prüfen: Wochentag + Status=aktiv');
}

console.log('✅ Event:', event.EventName);

let bildUrl = '';

// 1. SQLite EventBild (plain URL)
if (event.EventBild && event.EventBild.startsWith('http')) {
  bildUrl = event.EventBild;
}

// 2. NocoDB Attachment JSON (Fallback)
if (!bildUrl) {
  try {
    const att = event['Event-Bild'];
    const parsed = typeof att === 'string' ? JSON.parse(att) : att;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const p = parsed[0].signedPath || parsed[0].path || parsed[0].url || '';
      bildUrl = p.startsWith('http') ? p : 'https://nocodb.f3-events.de/' + p;
    }
  } catch(e) {
    console.log('⚠ Bild-Fehler:', e.message);
  }
}

if (!bildUrl) throw new Error('Kein Bild! EventBild per PATCH /api/events/:id setzen.');

console.log('🖼 Bild URL:', bildUrl);
return [{ json: { ...event, bildUrl, isMontag } }];`;

const EVENT_BILDER = {
  1: 'https://nocodb.f3-events.de/download/noco/pu4jkb0uwe4ebev/mo0qnkmte1sl1mj/cvk5suk0zttckj0/ChatGPT%20Image%2018.%20Jan.%202026%2C%2017_58_01_-yL6f.png',
  2: 'https://nocodb.f3-events.de/download/noco/pu4jkb0uwe4ebev/mo0qnkmte1sl1mj/cvk5suk0zttckj0/Friendly-Fucks%20Ulm_9lV68.png',
  3: 'https://nocodb.f3-events.de/download/noco/pu4jkb0uwe4ebev/mo0qnkmte1sl1mj/cvk5suk0zttckj0/F3-Mallorca_5YI96.png'
};

async function main() {
  // 1. Patch EventBild in production SQLite for 3 events
  console.log('\n── Patching EventBild in SQLite ──');
  for (const [id, url] of Object.entries(EVENT_BILDER)) {
    const r = await request('PATCH', `${COOKIE_CRAWLER}/api/events/${id}`, { EventBild: url });
    console.log(`Event ${id}: ${r.status} ${r.status === 200 ? '✓' : JSON.stringify(r.body).substring(0,100)}`);
  }

  // 2. Fetch autopost workflow
  console.log('\n── Fetching autopost workflow ──');
  const wfRes = await request('GET', `${N8N_BASE}/workflows/yqrgx2LvK6gHSyUx`, null, {
    'X-N8N-API-KEY': N8N_KEY
  });
  if (wfRes.status !== 200) {
    console.error('Failed to fetch workflow:', wfRes.status, wfRes.body);
    return;
  }
  const wf = wfRes.body;
  console.log('Workflow:', wf.name, '| versionId:', wf.versionId);

  // 3. Update the node code
  const node = wf.nodes.find(n => n.name === '✅ Event & Bild prüfen1');
  if (!node) { console.error('Node not found!'); return; }
  node.parameters.jsCode = NEW_CODE;
  console.log('Node updated ✓');

  // 4. PUT back
  const payload = {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: {
      executionOrder: 'v1',
      callerPolicy: wf.settings?.callerPolicy || 'workflowsFromSameOwner',
      ...(wf.settings?.errorWorkflow ? { errorWorkflow: wf.settings.errorWorkflow } : {})
    },
    staticData: wf.staticData || null
  };

  const putRes = await request('PUT', `${N8N_BASE}/workflows/yqrgx2LvK6gHSyUx`, payload, {
    'X-N8N-API-KEY': N8N_KEY
  });
  if (putRes.status === 200) {
    console.log('Workflow saved ✓ | versionId:', putRes.body.versionId);
  } else {
    console.error('PUT failed:', putRes.status, JSON.stringify(putRes.body).substring(0, 300));
  }
}

main().catch(console.error);
