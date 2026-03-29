// Adds "Jetzt Pushen" webhook to F3 autopost v4 workflow
// Run with: node patch_autopost_webhook.js

const N8N_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjY2YyY2YwNC1hYjAzLTRhM2MtYmU4Yi1jODk4OTA3ZGY2ZWIiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiODdmZjVhZDItMjI0My00MjJhLTg5NmEtZWNiYWM4ZDhjMmYzIiwiaWF0IjoxNzc0NTA3NDE2fQ.95tAiwtl4ZY6NzxMBllUzIWSVG4V5ZXUlt3HZu-sipU';
const WF_ID = 'yqrgx2LvK6gHSyUx';
const BASE = 'https://n8n.f3-events.de';

async function main() {
  // 1. Fetch workflow
  const res = await fetch(`${BASE}/api/v1/workflows/${WF_ID}`, {
    headers: { 'X-N8N-API-KEY': N8N_API_KEY }
  });
  if (!res.ok) throw new Error('Fetch failed: ' + res.status);
  const wf = await res.json();

  // 2. Add webhook node
  const webhookNode = {
    name: '🚀 Webhook: Jetzt Pushen',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [31616, 21760],
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    parameters: {
      path: 'f3-autopush-manual',
      httpMethod: 'POST',
      responseMode: 'responseNode',
      options: {}
    },
    webhookId: 'f3-autopush-manual'
  };

  // 3. Add "Respond to Webhook" node so it doesn't time out
  const respondNode = {
    name: '✉️ Webhook Antwort',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1,
    position: [32000, 21760],
    id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    parameters: {
      respondWith: 'json',
      responseBody: '={ "ok": true, "message": "Post wird vorbereitet..." }'
    }
  };

  // Check if nodes already exist (avoid duplicate)
  const existingWebhook = wf.nodes.find(n => n.name === '🚀 Webhook: Jetzt Pushen');
  if (existingWebhook) {
    console.log('⚠️  Webhook-Node existiert bereits – überspringe Hinzufügen');
  } else {
    wf.nodes.push(webhookNode);
    wf.nodes.push(respondNode);
    console.log('✅ Webhook-Node hinzugefügt');
  }

  // 4. Modify "✅ Cookie prüfen1" – handle missing Wochentag node (webhook trigger)
  const cookieCheck = wf.nodes.find(n => n.name === '✅ Cookie prüfen1');
  if (cookieCheck) {
    cookieCheck.parameters.jsCode = `const cookie = $input.item.json.Cookie || '';
if (!cookie) throw new Error('Kein Cookie in NocoDB! Tabelle Cookies → Eintrag F3-Events prüfen.');
console.log('✅ Cookie geladen');

// Wochentag: von Scheduler-Node, oder leer wenn manuell via Webhook getriggert
let wochentag = '';
let isMontag = false;
try {
  wochentag = $('📅 Wochentag ermitteln1').item.json.wochentag;
  isMontag  = $('📅 Wochentag ermitteln1').item.json.isMontag;
} catch(e) {
  // Webhook-Trigger: kein Wochentag nötig
  console.log('ℹ️  Manueller Trigger – kein Wochentag');
}

return [{ json: { cookie, wochentag, isMontag }}];`;
    console.log('✅ Cookie-Prüf-Node angepasst');
  }

  // 5. Modify "📅 Event nach Tag filtern1" – support eventId from webhook
  const tagFilter = wf.nodes.find(n => n.name === '📅 Event nach Tag filtern1');
  if (tagFilter) {
    tagFilter.parameters.jsCode = `// Filtert Events: entweder nach Wochentag (Scheduler) oder nach Event-ID (manuell)
const items = $input.all();

// Prüfen ob ein manueller Webhook-Trigger mit eventId vorliegt
let eventId = null;
try {
  const body = $('🚀 Webhook: Jetzt Pushen').item.json.body || $('🚀 Webhook: Jetzt Pushen').item.json;
  if (body && body.eventId) {
    eventId = String(body.eventId);
    console.log(\`🚀 Manueller Trigger für Event-ID: \${eventId}\`);
  }
} catch(e) {
  // Kein Webhook-Trigger
}

if (eventId) {
  // Manueller Push: Event nach ID suchen
  const matching = items.filter(item => String(item.json.Id) === eventId);
  console.log(\`📊 Events gesamt: \${items.length}, gefunden: \${matching.length}\`);
  if (matching.length === 0) {
    throw new Error(\`Event-ID \${eventId} nicht in NocoDB post-f3 View gefunden!\`);
  }
  return [matching[0]];
}

// Scheduler-Trigger: nach Wochentag filtern (bisherige Logik)
const wochentag = $('✅ Cookie prüfen1').item.json.wochentag;
console.log(\`📅 Suche Event für Wochentag: \${wochentag}\`);
console.log(\`📊 Alle Events in NocoDB: \${items.length}\`);

const matching = items.filter(item => {
  const w = (item.json.Wochentag || '').replace(/\\s/g, '');
  const tags = w.split(',');
  return tags.includes(wochentag);
});

console.log(\`✅ Passende Events: \${matching.length}\`);

if (matching.length === 0) {
  const alleWochentage = items.map(i => i.json.Wochentag).join(', ');
  throw new Error(
    \`Kein aktives Event für \${wochentag}! \`
    + \`Verfügbare Wochentage: \${alleWochentage}\`
  );
}

return [matching[0]];`;
    console.log('✅ Tag-Filter-Node angepasst');
  }

  // 6. Add connections
  if (!existingWebhook) {
    // Webhook → Cookie holen (existing node)
    if (!wf.connections['🚀 Webhook: Jetzt Pushen']) {
      wf.connections['🚀 Webhook: Jetzt Pushen'] = { main: [[
        { node: '🍪 Cookie aus NocoDB1', type: 'main', index: 0 },
        { node: '✉️ Webhook Antwort',    type: 'main', index: 0 }
      ]] };
    }
    console.log('✅ Verbindungen hinzugefügt');
  }

  // 7. PUT workflow back
  const { executionOrder, errorWorkflow, callerPolicy } = wf.settings || {};
  const putRes = await fetch(`${BASE}/api/v1/workflows/${WF_ID}`, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: { executionOrder, errorWorkflow, callerPolicy },
      staticData: wf.staticData || null
    })
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error('PUT failed ' + putRes.status + ': ' + err.substring(0, 300));
  }
  console.log('✅ Workflow gespeichert');

  // 8. Activate
  const actRes = await fetch(`${BASE}/api/v1/workflows/${WF_ID}/activate`, {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': N8N_API_KEY }
  });
  console.log('✅ Workflow aktiviert:', actRes.status);

  // Print webhook URL
  console.log('\n🔗 Webhook URL: https://n8n.f3-events.de/webhook/f3-autopush-manual');
  console.log('   POST body: { "eventId": "123", "eventName": "F³ Event" }');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
