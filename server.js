// F3 Cookie Crawler – REST Bridge für Chrome DevTools Protocol
// Läuft intern im Docker-Netzwerk, stellt /cookies Endpoint für n8n bereit

const http = require('http');
const WebSocket = require('ws');

const CHROME_HOST = process.env.F3_CHROME_HOST || '847d53580545';
const CHROME_PORT = parseInt(process.env.F3_CHROME_PORT || '9222');
const PORT = parseInt(process.env.PORT || '3000');
const FILTER_DOMAIN = process.env.FILTER_DOMAIN || 'joyclub';

// ── CDP Helpers ──────────────────────────────────────────────────────────────

function getCDPTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CHROME_HOST}:${CHROME_PORT}/json/list`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find(t => t.type === 'page') || targets[0];
          if (!page) return reject(new Error('Keine offene Browser-Seite gefunden'));
          // Rewrite internal localhost:9222 → proxy host:port (erreichbar im Docker-Netz)
          const wsUrl = page.webSocketDebuggerUrl.replace('localhost:9222', `${CHROME_HOST}:${CHROME_PORT}`);
          resolve(wsUrl);
        } catch (e) { reject(e); }
      });
    }).on('error', err => reject(new Error(`Chromium nicht erreichbar (${CHROME_HOST}:${CHROME_PORT}): ${err.message}`)));
  });
}

function getAllCookiesViaCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
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

function getParticipantsViaCDP(wsUrl, eventId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const TIMEOUT = 30_000;
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

    ws.on('open', async () => {
      timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP Participants Timeout'));
      }, TIMEOUT);

      try {
        const url = `https://www.joyclub.de/event/${eventId}/ticket_management/${eventId}.html`;
        await send('Page.enable');
        await send('Page.navigate', { url });

        // Warte auf loadEventFired
        await new Promise(res => {
          const onMsg = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method === 'Page.loadEventFired') {
              ws.removeListener('message', onMsg);
              res();
            }
          };
          ws.on('message', onMsg);
        });

        // Aktuelle URL + Titel für Debugging
        const urlResult = await send('Runtime.evaluate', {
          expression: `JSON.stringify({ url: location.href, title: document.title })`,
          returnByValue: true
        });
        const pageInfo = JSON.parse(urlResult.result?.value || '{}');
        console.log(`[participants] Nach Navigation: ${pageInfo.url} | ${pageInfo.title}`);

        // Warte 8s initial damit SPA-API-Calls abgeschlossen
        await new Promise(res => setTimeout(res, 8000));

        // Snapshot nach 8s: alle Links + Bilder + Body-Größe
        const snapResult = await send('Runtime.evaluate', {
          expression: `JSON.stringify({
            profileLinks: [...new Set([...document.querySelectorAll('a[href*="profile"]')].map(a => a.href))],
            allLinks: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h && !h.endsWith('#/')),
            userImgs: [...document.querySelectorAll('img[src*="image-user"]')].map(a => a.src),
            bodyLen: document.body?.innerHTML?.length || 0
          })`,
          returnByValue: true
        });
        const snap = JSON.parse(snapResult.result?.value || '{}');
        console.log(`[participants] 8s Snapshot: bodyLen=${snap.bodyLen} profileLinks=${snap.profileLinks?.length} allLinks=${snap.allLinks?.length} userImgs=${snap.userImgs?.length}`);
        console.log(`[participants] Sample links: ${JSON.stringify(snap.allLinks?.slice(0, 15))}`);
        console.log(`[participants] User imgs: ${JSON.stringify(snap.userImgs?.slice(0, 5))}`);

        let profiles = snap.profileLinks || [];
        let debugLinks = snap.allLinks || [];

        clearTimeout(timer);
        ws.close();
        resolve({ profiles, pageInfo, debugLinks });
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending[msg.id]) {
        const { res, rej } = pending[msg.id];
        delete pending[msg.id];
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Content-Type', 'application/json');

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

