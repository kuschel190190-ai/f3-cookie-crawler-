// F3 Cookie Crawler – REST Bridge für Chrome DevTools Protocol
// Läuft intern im Docker-Netzwerk, stellt /cookies Endpoint für n8n bereit

const http = require('http');
const WebSocket = require('ws');
const os = require('os');

const CHROME_HOST = process.env.F3_CHROME_HOST || '847d53580545';
const CHROME_PORT = parseInt(process.env.F3_CHROME_PORT || '9222');
const PORT = parseInt(process.env.PORT || '3000');
const FILTER_DOMAIN = process.env.FILTER_DOMAIN || 'joyclub';

const NOCODB_URL        = process.env.NOCODB_URL        || 'https://nocodb.f3-events.de';
const NOCODB_TOKEN      = process.env.NOCODB_TOKEN      || '';
const NOCODB_PROJECT_ID = process.env.NOCODB_PROJECT_ID || '';
const NOCODB_TABLE_ID   = process.env.NOCODB_TABLE_ID   || '';

// Credentials werden beim Dashboard-Login im RAM gespeichert (kein Env-Var nötig)
let storedCredentials = null;

// ── NocoDB Helper ─────────────────────────────────────────────────────────────

async function updateNocoDBCookies(cookieString, ablaufdatum, count) {
  if (!NOCODB_TOKEN || !NOCODB_PROJECT_ID || !NOCODB_TABLE_ID) return;
  try {
    const https = require('https');
    // Erst Record-ID holen
    const records = await new Promise((resolve, reject) => {
      const req = https.get(`${NOCODB_URL}/api/v1/db/data/noco/${NOCODB_PROJECT_ID}/${NOCODB_TABLE_ID}?limit=1`, {
        headers: { 'xc-token': NOCODB_TOKEN }
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
    });
    const rowId = records?.list?.[0]?.Id;
    if (!rowId) return;

    // Record updaten
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ Cookie: cookieString, Ablaufdatum: ablaufdatum });
      const url = new URL(`${NOCODB_URL}/api/v1/db/data/noco/${NOCODB_PROJECT_ID}/${NOCODB_TABLE_ID}/${rowId}`);
      const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'PATCH',
        headers: { 'xc-token': NOCODB_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body); req.end();
    });
    console.log(`[nocodb] Cookies aktualisiert (${count} Cookies, gültig bis ${ablaufdatum})`);
  } catch(e) {
    console.error(`[nocodb] Update fehlgeschlagen: ${e.message}`);
  }
}

// ── CDP Helpers ──────────────────────────────────────────────────────────────

// Ermittelt mögliche Chromium-Hostnamen: konfigurierten + Basis-Name (ohne Coolify-Hash)
function getChromeHostCandidates() {
  const candidates = [CHROME_HOST];
  // Coolify erzeugt Namen wie "chromium-abc123xyz" → Basis "chromium" als Fallback
  const baseMatch = CHROME_HOST.match(/^([a-z][a-z0-9-]+?)-[a-f0-9]{15,}$/i);
  if (baseMatch) candidates.push(baseMatch[1]);
  // Bekannte Docker-Dienstnamen als weitere Fallbacks
  for (const name of ['chromium', 'chrome', 'browserless']) {
    if (!candidates.includes(name)) candidates.push(name);
  }
  return candidates;
}

function tryGetCDPFromHost(host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: host, port: CHROME_PORT, path: '/json/list', headers: { 'Host': 'localhost' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find(t => t.type === 'page') || targets[0];
          if (!page) return reject(new Error('Keine offene Browser-Seite gefunden'));
          const wsUrl = page.webSocketDebuggerUrl
            .replace(/localhost(:\d+)?/, `${host}:${CHROME_PORT}`)
            .replace(/127\.0\.0\.1(:\d+)?/, `${host}:${CHROME_PORT}`);
          resolve({ wsUrl, host });
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function getCDPTarget() {
  const candidates = getChromeHostCandidates();
  let lastErr;
  for (const host of candidates) {
    try {
      const { wsUrl, host: found } = await tryGetCDPFromHost(host);
      if (found !== CHROME_HOST) console.log(`[chrome-discovery] Chromium gefunden via Fallback: ${found}:${CHROME_PORT}`);
      return wsUrl;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Chromium nicht erreichbar (versucht: ${candidates.join(', ')} :${CHROME_PORT}): ${lastErr?.message}`);
}

function getAllCookiesViaCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const TIMEOUT = 10_000;
    let timer;

    ws.on('open', () => {
      timer = setTimeout(() => { ws.close(); reject(new Error('CDP Timeout')); }, TIMEOUT);
      // Network.enable dann getAllCookies
      ws.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }));
      ws.send(JSON.stringify({ id: 2, method: 'Network.getAllCookies', params: {} }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id === 2) {
        clearTimeout(timer);
        ws.close();
        if (msg.result?.cookies) resolve(msg.result.cookies);
        else reject(new Error(msg.error?.message || 'Keine Cookies in CDP-Antwort'));
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function loginViaCDP(wsUrl, username, password, forceRelogin = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const TIMEOUT = 65_000;
    let timer;
    let msgId = 0;
    const pending = {};

    const send = (method, params = {}) => {
      const id = ++msgId;
      return new Promise((res, rej) => {
        pending[id] = { res, rej };
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.id && pending[msg.id]) {
          const { res, rej } = pending[msg.id];
          delete pending[msg.id];
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      } catch(e) {}
    });

    ws.on('open', async () => {
      timer = setTimeout(() => { ws.close(); reject(new Error('Login Timeout')); }, TIMEOUT);
      try {
        await send('Page.enable');

        // Schritt 0: Prüfen ob Chromium noch eingeloggt ist (nur bei auto-login, nicht bei manuellem Aufruf)
        if (!forceRelogin) {
          await send('Page.navigate', { url: 'https://www.joyclub.de/my_joy/feed/friends/' });
          await new Promise(res => setTimeout(res, 6000));
          const preCheck = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
          const preUrl = preCheck.result?.value || '';
          if (!preUrl.includes('/login') && !preUrl.includes('cfidentity') && !preUrl.includes('identity.joyclub')) {
            // Noch eingeloggt – kein neuer Login nötig
            clearTimeout(timer);
            ws.close();
            return resolve({ success: true, url: preUrl, skipped: true });
          }
        }

        // Login-Seite über Homepage laden (Cloudflare-Vertrauen aufbauen)
        await send('Page.navigate', { url: 'https://www.joyclub.de/' });
        await new Promise(res => setTimeout(res, 4000));
        await send('Page.navigate', { url: 'https://www.joyclub.de/login/' });

        // Warten bis Login-Seite geladen (inkl. OAuth-Redirect zu identity.joyclub.com)
        await new Promise(res => setTimeout(res, 10000));

        const loginPageCheck = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const loginPageUrl = loginPageCheck.result?.value || '';
        console.log(`[login] Login-Seite: ${loginPageUrl}`);

        // Username eintragen
        await send('Runtime.evaluate', {
          expression: `
            (function() {
              const el = document.querySelector(
                'input[name="username"], input[name="login"], input[autocomplete="username"], ' +
                'input[type="text"]:not([type="password"]), input[type="email"]'
              );
              if (!el) throw new Error('Username-Feld nicht gefunden');
              el.focus();
              el.value = ${JSON.stringify(username)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return el.value;
            })()
          `,
          returnByValue: true
        });

        await new Promise(res => setTimeout(res, 1000));

        // Password eintragen
        await send('Runtime.evaluate', {
          expression: `
            (function() {
              const el = document.querySelector('input[type="password"]');
              if (!el) throw new Error('Password-Feld nicht gefunden');
              el.focus();
              el.value = ${JSON.stringify(password)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return el.value.length;
            })()
          `,
          returnByValue: true
        });

        await new Promise(res => setTimeout(res, 1000));

        // "Angemeldet bleiben" aktivieren
        const cbRes = await send('Runtime.evaluate', {
          expression: `
            (function() {
              const cb = document.querySelector('input[type="checkbox"]');
              if (cb && !cb.checked) { cb.click(); }
              return cb ? { found: true, checked: cb.checked } : { found: false };
            })()
          `,
          returnByValue: true
        });
        console.log('[login] Remember-Me:', JSON.stringify(cbRes.result?.value));

        // Turnstile nur abwarten wenn vorhanden
        const tsCheck = await send('Runtime.evaluate', {
          expression: `!!document.querySelector('iframe[src*="challenges.cloudflare"], .cf-turnstile, [data-sitekey], iframe[title*="Cloudflare"]')`,
          returnByValue: true
        });
        const hasTurnstile = tsCheck.result?.value === true;
        console.log(`[login] Turnstile vorhanden: ${hasTurnstile}`);
        await new Promise(res => setTimeout(res, hasTurnstile ? 20000 : 3000));

        // Submit
        await send('Runtime.evaluate', {
          expression: `
            (function() {
              const btn = document.querySelector('button[type="submit"], input[type="submit"]');
              if (!btn) throw new Error('Submit-Button nicht gefunden');
              btn.click();
              return true;
            })()
          `,
          returnByValue: true
        });

        // Warten auf Redirect nach Login
        await new Promise(res => setTimeout(res, 10000));

        const urlRes = await send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true
        });
        const currentUrl = urlRes.result?.value || '';
        const loggedIn = !currentUrl.includes('/login') && !currentUrl.includes('cfidentity') && !currentUrl.includes('identity.joyclub');

        clearTimeout(timer);
        ws.close();
        resolve({ success: loggedIn, url: currentUrl });
      } catch(e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function getParticipantsViaCDP(wsUrl, eventId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const TIMEOUT = 50_000;
    let timer;
    let msgId = 0;
    const pending = {};

    const send = (method, params = {}) => {
      const id = ++msgId;
      return new Promise((res, rej) => {
        pending[id] = { res, rej };
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.id && pending[msg.id]) {
          const { res, rej } = pending[msg.id];
          delete pending[msg.id];
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      } catch(e) {}
    });

    ws.on('open', async () => {
      timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP Participants Timeout'));
      }, TIMEOUT);

      try {
        const navUrl = `https://www.joyclub.de/event/${eventId}/ticket_management/`;

        await send('Page.enable');

        // Fetch/XHR Interceptor VOR Seitenstart – fängt alles ab bevor SPA performace.clearResourceTimings() aufrufen kann
        await send('Page.addScriptToEvaluateOnNewDocument', {
          source: [
            'window.__joyReqs=[];window.__joyData={};',
            'var _f=window.fetch;',
            'window.fetch=function(a,b){',
            '  var u=typeof a==="string"?a:(a&&a.url)||""+a;',
            '  window.__joyReqs.push(u);',
            '  var p=_f.apply(this,arguments);',
            '  p.then(function(r){return r.clone().text();}).then(function(t){window.__joyData[u]=t;}).catch(function(){});',
            '  return p;',
            '};',
            'var _x=XMLHttpRequest.prototype.open;',
            'XMLHttpRequest.prototype.open=function(m,u){window.__joyReqs.push(""+u);return _x.apply(this,arguments);};'
          ].join('')
        });

        await send('Page.navigate', { url: navUrl });

        // loadEventFired abwarten (max 15s)
        await new Promise(function(res) {
          var done = false;
          var t = setTimeout(function(){ if(!done){done=true;res();} }, 15000);
          ws.on('message', function onMsg(raw) {
            try {
              var msg = JSON.parse(raw);
              if (msg.method === 'Page.loadEventFired' && !done) {
                done=true; clearTimeout(t); ws.removeListener('message', onMsg); res();
              }
            } catch(e){}
          });
        });

        // SPA-Initialisierung abwarten
        await new Promise(res => setTimeout(res, 10000));

        // Abgefangene Requests lesen
        const reqRes = await send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__joyReqs||[])',
          returnByValue: true
        });
        const capturedReqs = JSON.parse(reqRes.result?.value || '[]');
        console.log('[participants] event=' + eventId + ' captured ' + capturedReqs.length + ' requests:');
        capturedReqs.forEach(function(r){ console.log('  ' + r); });

        // Response-Bodies lesen
        const dataRes = await send('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__joyData||{})',
          returnByValue: true
        });
        const capturedData = JSON.parse(dataRes.result?.value || '{}');

        // Profil-URLs aus Response-Bodies extrahieren
        let profiles = [];
        for (const [url, text] of Object.entries(capturedData)) {
          if (!text) continue;
          console.log('[participants] response[' + url + ']: ' + text.substring(0, 300));
          const found = [...text.matchAll(/profile\/[\w\d._-]+\.html/g)].map(function(m){ return 'https://www.joyclub.de/' + m[0]; });
          if (found.length) profiles.push(...found);
        }
        profiles = [...new Set(profiles)];

        const pageInfo = JSON.parse((await send('Runtime.evaluate', {
          expression: 'JSON.stringify({url:location.href,title:document.title})',
          returnByValue: true
        })).result?.value || '{}');

        clearTimeout(timer);
        ws.close();
        resolve({ profiles, pageInfo, debugRequests: capturedReqs });
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Status Store (n8n schreibt rein, Dashboard liest) ────────────────────────
// In-Memory, wird bei Container-Neustart geleert – ist ok, n8n schreibt nach jedem Lauf
const statusStore = {};

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');

  // GET /metrics  →  Server-Auslastung (CPU, RAM, Uptime)
  if (url.pathname === '/metrics') {
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const ramPct   = Math.round((usedMem / totalMem) * 100);
    const cpuLoad  = os.loadavg()[0];          // 1-min Load Average
    const cpuCores = os.cpus().length;
    const cpuPct   = Math.min(100, Math.round((cpuLoad / cpuCores) * 100));
    const uptimeSec = Math.floor(os.uptime());

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      cpu:    { pct: cpuPct,  load1: +cpuLoad.toFixed(2), cores: cpuCores },
      ram:    { pct: ramPct,  usedMB: Math.round(usedMem/1024/1024), totalMB: Math.round(totalMem/1024/1024) },
      uptime: uptimeSec,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // POST /status  →  n8n schreibt Workflow-Status rein
  // Body: { "key": "autopost", "data": { "posts": [...], "lastRunAt": "..." } }
  if (url.pathname === '/status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { key, data } = JSON.parse(body);
        if (!key) { res.writeHead(400); res.end(JSON.stringify({ error: 'key fehlt' })); return; }
        statusStore[key] = { ...data, updatedAt: new Date().toISOString() };
        console.log(`[status] ${key} aktualisiert`);
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /status/:key  →  Dashboard liest Status
  if (url.pathname.startsWith('/status/') && req.method === 'GET') {
    const key = url.pathname.slice('/status/'.length);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(statusStore[key] || null));
    return;
  }

  // GET /debug  →  Chrome-Discovery testen
  if (url.pathname === '/debug') {
    const candidates = getChromeHostCandidates();
    const results = await Promise.all(candidates.map(host =>
      tryGetCDPFromHost(host)
        .then(({ host: h }) => ({ host: h, ok: true }))
        .catch(e => ({ host, ok: false, error: e.message }))
    ));
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ configured: CHROME_HOST, port: CHROME_PORT, candidates: results }));
    return;
  }

  // GET /health
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      chromium: `${CHROME_HOST}:${CHROME_PORT}`,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // GET /cookies  →  JOYclub-Cookies aus laufendem Chromium
  if (url.pathname === '/cookies') {
    try {
      console.log(`[${new Date().toISOString()}] Cookie-Extraktion gestartet...`);

      const wsUrl = await getCDPTarget();
      console.log(`CDP Target: ${wsUrl}`);

      const allCookies = await getAllCookiesViaCDP(wsUrl);
      console.log(`Alle Cookies: ${allCookies.length}`);

      const filtered = allCookies.filter(c =>
        c.domain && c.domain.toLowerCase().includes(FILTER_DOMAIN)
      );
      console.log(`${FILTER_DOMAIN} Cookies: ${filtered.length}`);

      // Cookie-Header-String für HTTP-Requests
      const cookieString = filtered.map(c => `${c.name}=${c.value}`).join('; ');

      // Ablaufdatum: spätestes Cookie-Ablaufdatum
      const maxExpiry = filtered.reduce((max, c) => {
        return c.expires > 0 ? Math.max(max, c.expires) : max;
      }, 0);
      const ablaufdatum = maxExpiry > 0
        ? new Date(maxExpiry * 1000).toISOString().split('T')[0]
        : null;

      // NocoDB direkt aktualisieren (kein n8n-Umweg nötig)
      updateNocoDBCookies(cookieString, ablaufdatum, filtered.length).catch(() => {});

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        count: filtered.length,
        cookieString,
        ablaufdatum,
        cookies: filtered.map(c => ({ name: c.name, domain: c.domain, expires: c.expires })),
        timestamp: new Date().toISOString()
      }));

    } catch (err) {
      console.error(`Fehler: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // POST /login  →  Automatischer JOYclub-Login via CDP
  // Body: { "username": "...", "password": "..." }
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body || '{}');
        if (!username || !password) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'username und password im JSON-Body erforderlich' }));
          return;
        }
        console.log(`[${new Date().toISOString()}] Auto-Login für ${username}...`);
        const wsUrl = await getCDPTarget();
        const result = await loginViaCDP(wsUrl, username, password, true); // force re-login (Remember Me aktivieren)
        console.log(`Login ${result.success ? 'erfolgreich' : 'fehlgeschlagen'} | URL: ${result.url}`);
        if (result.success) storedCredentials = { username, password };
        res.writeHead(result.success ? 200 : 401);
        res.end(JSON.stringify({ success: result.success, url: result.url }));
      } catch(err) {
        console.error(`Login-Fehler: ${err?.message || '(kein message)'} | code=${err?.code} | type=${err?.type}`);
        console.error(err?.stack || String(err));
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
      }
    });
    return;
  }

  // GET /auto-login  →  Login mit gespeicherten Env-Credentials (für n8n Cookie Sync)
  if (url.pathname === '/auto-login' && req.method === 'GET') {
    if (!storedCredentials) {
      res.writeHead(503);
      res.end(JSON.stringify({ success: false, error: 'Noch kein Login über Dashboard erfolgt – bitte zuerst manuell einloggen' }));
      return;
    }
    try {
      const { username: u, password: p } = storedCredentials;
      console.log(`[${new Date().toISOString()}] Auto-Login (n8n) für ${u}...`);
      const wsUrl = await getCDPTarget();
      const result = await loginViaCDP(wsUrl, u, p);
      console.log(`Auto-Login ${result.success ? 'erfolgreich' : 'fehlgeschlagen'} | URL: ${result.url}`);
      res.writeHead(result.success ? 200 : 401);
      res.end(JSON.stringify({ success: result.success, url: result.url }));
    } catch(err) {
      console.error(`Auto-Login Fehler: ${err?.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err?.message || String(err) }));
    }
    return;
  }

  // GET /participants?event_id=1829501  →  Profil-URLs der Angemeldeten via CDP SPA-Rendering
  if (url.pathname === '/participants') {
    const eventId = url.searchParams.get('event_id');
    if (!eventId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'event_id Parameter fehlt' }));
      return;
    }
    try {
      console.log(`[${new Date().toISOString()}] Teilnehmer-Extraktion für Event ${eventId}...`);
      const wsUrl = await getCDPTarget();
      const result = await getParticipantsViaCDP(wsUrl, eventId);
      const profiles = result.profiles || [];
      const pageInfo = result.pageInfo || {};
      console.log(`Event ${eventId}: ${profiles.length} Profile gefunden | URL: ${pageInfo.url}`);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, event_id: eventId, profiles, count: profiles.length, pageInfo, debugLinks: result.debugLinks || [] }));
    } catch (err) {
      console.error(`Fehler: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`F3 Cookie Crawler läuft auf Port ${PORT}`);
  console.log(`Chromium: ${CHROME_HOST}:${CHROME_PORT}`);
  console.log(`Filter: ${FILTER_DOMAIN}`);
});

