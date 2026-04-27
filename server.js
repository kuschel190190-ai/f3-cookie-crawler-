// F3 Cookie Crawler – REST Bridge für Chrome DevTools Protocol
// Läuft intern im Docker-Netzwerk, stellt /cookies Endpoint für n8n bereit

const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const db = require('./db');

const CHROME_HOST = process.env.F3_CHROME_HOST || '847d53580545';
const CHROME_PORT = parseInt(process.env.F3_CHROME_PORT || '9222');
const PORT = parseInt(process.env.PORT || '3000');
const FILTER_DOMAIN = process.env.FILTER_DOMAIN || 'joyclub';

// Credentials werden beim Dashboard-Login im RAM + auf Disk gespeichert (überlebt Restarts)
const CREDS_FILE = require('path').join(require('os').tmpdir(), '.f3_creds.json');
let storedCredentials = null;
try {
  const raw = require('fs').readFileSync(CREDS_FILE, 'utf8');
  storedCredentials = JSON.parse(raw);
  console.log(`[startup] Credentials geladen für: ${storedCredentials.username}`);
} catch(e) { /* noch keine Credentials gespeichert */ }

function persistCredentials(creds) {
  storedCredentials = creds;
  try { require('fs').writeFileSync(CREDS_FILE, JSON.stringify(creds), 'utf8'); } catch(e) {}
}

// KI-Entwürfe: name → { draft, createdAt } (in-memory, kein Persist nötig)
const messageDrafts = new Map();

// Auto-Reply-Log: Array von { id, name, type, sentAt, replyText, convId, convUrl }
const AUTO_REPLY_LOG_FILE = require('path').join(require('os').tmpdir(), '.f3_auto_reply_log.json');
let autoReplyLog = [];
try {
  const raw = require('fs').readFileSync(AUTO_REPLY_LOG_FILE, 'utf8');
  autoReplyLog = JSON.parse(raw);
  console.log(`[startup] Auto-Reply-Log geladen: ${autoReplyLog.length} Einträge`);
} catch(e) { /* noch kein Log gespeichert */ }

function persistAutoReplyLog() {
  try { require('fs').writeFileSync(AUTO_REPLY_LOG_FILE, JSON.stringify(autoReplyLog), 'utf8'); } catch(e) {}
}

// Konversations-URL-Cache: name → relative JOYclub-URL (z.B. /clubmail/123456/)
// Persistiert Server-seitig; wird beim Laden der Liste befüllt, ermöglicht direktes Thread-Navigieren
const convUrlCache = new Map();

// ── Thread-Cache: schnelle Antworten für Dashboard + WF5 ─────────────────────
// name → { messages, fetchedAt, id, url }
const threadCache = new Map();

// ── Messages-List-Cache ───────────────────────────────────────────────────────
// Stale-while-revalidate: Cache sofort zurück, CDP nur bei Bedarf
let messagesListCache = null;    // letztes Ergebnis (wird an Client gesendet)
let messagesListCachedAt = 0;    // Timestamp des letzten erfolgreichen Full-Fetch
let messagesListDirty = false;   // true → nächster /messages-Aufruf löst Full-Fetch aus
const MESSAGES_LIST_CACHE_TTL = 90 * 1000; // 90s – danach stale-while-revalidate

// CDP-Mutex: nur 1 CDP-Request gleichzeitig (verhindert Konflikte bei parallelen WF5-Calls)
let _cdpLock = false;
const _cdpQueue = [];

async function withCDPLock(fn, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    _cdpQueue.push({ fn, resolve, reject, deadline: Date.now() + timeoutMs });
    _drainCDP();
  });
}

async function _drainCDP() {
  if (_cdpLock || _cdpQueue.length === 0) return;
  const task = _cdpQueue.shift();
  if (Date.now() > task.deadline) {
    task.reject(new Error('CDP Queue Timeout'));
    _drainCDP();
    return;
  }
  _cdpLock = true;
  try { task.resolve(await task.fn()); }
  catch(e) { task.reject(e); }
  finally {
    _cdpLock = false;
    await new Promise(r => setTimeout(r, 400));
    _drainCDP();
  }
}

// Hintergrund-Thread-Refresh: lädt bekannte Threads alle 90s sequentiell
let _bgRefreshRunning = false;
async function _bgRefreshThreads() {
  if (_bgRefreshRunning || threadCache.size === 0) return;
  _bgRefreshRunning = true;
  const entries = [...threadCache.entries()];
  const stale = entries.filter(([, v]) => Date.now() - new Date(v.fetchedAt).getTime() > 80 * 1000);
  for (const [name, meta] of stale) {
    try {
      const data = await withCDPLock(async () => {
        const ws = await getCDPTarget();
        return fetchClubMailThreadViaCDP(ws, meta.id || name, name, meta.url);
      }, 60000);
      if (data.messages?.length) {
        threadCache.set(name, { messages: data.messages, fetchedAt: new Date().toISOString(), id: meta.id, url: meta.url });
        console.log('[Cache] Refresh:', name, data.messages.length, 'Msgs');
      }
    } catch(e) { /* ignorieren */ }
  }
  _bgRefreshRunning = false;
}
// Alle 90 Sekunden stale Threads refreshen
setInterval(_bgRefreshThreads, 90 * 1000);

// ── Messages Light-Check: nur Unread-Count lesen, kein Page-Navigate ─────────
// Liest den Nav-Badge (#clubmail_notify) aus – funktioniert auf jeder JOYclub-Seite.
// Kein Scrollen, keine Navigation → keine Interferenz mit der Browser-Session.
async function lightGetUnreadCount(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const timer = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(null); }, 4000);
    let _mid = 0; const pending = {};
    const send = (method, params = {}) => {
      const id = ++_mid;
      return new Promise((res, rej) => { pending[id] = { res, rej }; ws.send(JSON.stringify({ id, method, params })); });
    };
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.id && pending[msg.id]) {
          const { res, rej } = pending[msg.id]; delete pending[msg.id];
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        }
      } catch(e) {}
    });
    ws.on('error', () => { clearTimeout(timer); resolve(null); });
    ws.on('open', async () => {
      try {
        const r = await send('Runtime.evaluate', {
          expression: `(function(){
            try {
              const li = document.getElementById('clubmail_notify');
              if (!li) return -1;
              const s = li.getAttribute('data-clubmail-state');
              if (s) { const d = JSON.parse(s); return d.unread_conversation_count || 0; }
              const b = li.querySelector('.counter_badge');
              return b ? (parseInt(b.textContent) || 0) : 0;
            } catch(e) { return -1; }
          })()`,
          returnByValue: true
        });
        clearTimeout(timer);
        ws.close();
        const val = r.result?.value;
        resolve(typeof val === 'number' ? val : null);
      } catch(e) { clearTimeout(timer); try { ws.close(); } catch(e2) {} resolve(null); }
    });
  });
}

async function backgroundMessagesLightCheck() {
  if (!messagesListCache) return; // Noch kein Cache – skip
  try {
    const wsUrl = await getCDPTarget();
    const count = await withCDPLock(() => lightGetUnreadCount(wsUrl), 5000);
    if (count === null) return; // CDP nicht erreichbar
    if (count !== (messagesListCache.totalCount || 0)) {
      messagesListDirty = true;
      console.log(`[Messages] Light-Check: unread ${messagesListCache.totalCount} → ${count} → dirty`);
    }
  } catch(e) { /* CDP busy oder nicht verfügbar – ignorieren */ }
}
// Alle 60s leicht prüfen ob neue Nachrichten da sind
setInterval(backgroundMessagesLightCheck, 60_000);


// ── HTTP-Fetch Helper ─────────────────────────────────────────────────────────

function fetchPageWithCookies(urlStr, cookieHeader, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) { reject(new Error('Zu viele Redirects')); return; }
    const https = require('https');
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9',
        'Accept-Encoding': 'identity',
      }
    }, res => {
      if ([301, 302, 303].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const nextUrl = loc.startsWith('http') ? loc : `${u.protocol}//${u.hostname}${loc}`;
        res.resume();
        fetchPageWithCookies(nextUrl, cookieHeader, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let html = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (html.length < 800_000) html += chunk; });
      res.on('end', () => resolve({ html, status: res.statusCode, finalUrl: urlStr }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('HTTP Timeout')); });
    req.end();
  });
}

// ── JOYclub Notification Parser ───────────────────────────────────────────────

const TYPE_ICONS = {
  user_fav_fans:      '⭐',
  event_registration: '🎟',
  event_cancellation: '❌',
  cancellation:       '❌',
  fan:                '⭐',
  message:            '✉️',
  profile_view:       '👁',
  comment:            '💬',
  group_join:         '👥',
  like:               '❤️',
  photo:              '📷',
  forum_topic:        '💬',
  group:              '👥',
};

function parseJoyclubNotifications(html, finalUrl) {
  if (/identity\.joyclub|\/login|logged_out/i.test(finalUrl)) {
    return { loggedOut: true, totalCount: 0, items: [] };
  }

  // Unread counter — zuerst data-notification-count, dann Nachrichten-Badge aus Nav
  let totalCount = 0;
  const notifCountM = html.match(/data-notification-count="(\d+)"/) ||
                      html.match(/id="nav[-_]?notif[^"]*"[\s\S]{0,300}?counter_badge[^>]*>(\d+)</) ||
                      html.match(/Nachrichten[^<]{0,100}counter_badge[^>]*>(\d+)</);
  if (notifCountM) {
    totalCount = parseInt(notifCountM[1]);
  } else {
    // Anzahl ungelesener Items direkt zählen
    totalCount = (html.match(/\bnotification\b[^"]*\blist-group-item\b(?![^"]*\bread\b)/g) || []).length;
  }

  const items = [];

  // Helper: Text-Nodes aus HTML-Chunk extrahieren
  function extractTexts(chunk) {
    return [...chunk.matchAll(/>([^<]+)</g)]
      .map(t => t[1].replace(/\r?\n/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim())
      .filter(t => t.length > 2 && !/^\s*$/.test(t));
  }

  // Ansatz 1: <a class="... notification list-group-item ..."> (gängigste JOYclub-Struktur)
  const notifRe = /<a\s([^>]*class="[^"]*(?:notification[^"]*list-group-item|list-group-item[^"]*notification)[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = notifRe.exec(html)) !== null && items.length < 50) {
    const attrs   = m[1];
    const content = m[2];

    const titleAttrM = attrs.match(/\btitle="([^"]+)"/);
    const hrefM      = attrs.match(/\bhref="([^"]+)"/);
    const idM        = attrs.match(/data-notification-id="([^"]+)"/);
    const subCatM    = attrs.match(/data-notification-sub-category="([^"]+)"/);
    const typeM      = attrs.match(/data-notification-object-type="([^"]+)"/);
    const isRead     = /\bread\b/.test((attrs.match(/class="([^"]+)"/) || [])[1] || '');

    const type = typeM?.[1] || '';
    const icon = TYPE_ICONS[type] || '🔔';

    const imgM = content.match(/<img\s[^>]*src="([^"]+)"/);
    let avatar = imgM ? imgM[1] : null;
    if (avatar && avatar.startsWith('/')) avatar = 'https://www.joyclub.de' + avatar;

    // Titel: aus title-Attribut (HTML-Entities dekodieren) oder ersten Text-Node
    const titleRaw = (titleAttrM?.[1] || '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n));

    const allTexts = extractTexts(content);
    const title    = titleRaw || allTexts[0] || 'Benachrichtigung';
    const subtitle = allTexts.find(t => t !== title && !/^\d{2}[.:]/.test(t)) || null;
    const dateM    = content.match(/(\d{2}\.\d{2}\.\d{2,4})/);

    const url = hrefM?.[1]
      ? (hrefM[1].startsWith('http') ? hrefM[1] : 'https://www.joyclub.de' + hrefM[1])
      : 'https://www.joyclub.de/benachrichtigung/';

    items.push({ id: idM?.[1]||null, title: title||'Benachrichtigung', subtitle, avatar, icon,
                 category: subCatM?.[1]||type, url, date: dateM?.[1]||null, unread: !isRead });
  }

  // Ansatz 2 (Fallback): split auf notification-object-type= – robuster gegen class-Varianten
  if (items.length === 0) {
    const blocks = html.split('notification-object-type=');
    for (let i = 1; i < blocks.length && items.length < 50; i++) {
      const block    = blocks[i];
      const typeM2   = block.match(/^["']([^"']{1,60})["']/);
      if (!typeM2) continue;
      const type2    = typeM2[1].trim();
      const icon2    = TYPE_ICONS[type2] || '🔔';
      const chunk    = block.substring(0, 3000);

      const hrefM2   = chunk.match(/href="(\/[^"]+)"/);
      const url2     = hrefM2 ? 'https://www.joyclub.de' + hrefM2[1] : 'https://www.joyclub.de/benachrichtigung/';

      const imgM2    = chunk.match(/<img\s[^>]*src="([^"]+)"/);
      let avatar2    = imgM2 ? imgM2[1] : null;
      if (avatar2 && avatar2.startsWith('/')) avatar2 = 'https://www.joyclub.de' + avatar2;

      const allTexts2 = extractTexts(chunk);
      // Präferiere Texte mit Muster "1 Stornierung" als Titel (Zähler + Wort)
      const summaryT  = allTexts2.find(t => /^\d+\s+\w/i.test(t));
      const title2    = summaryT || allTexts2[0] || type2 || 'Benachrichtigung';
      const subtitle2 = allTexts2.find(t => t !== title2 && t.length > 6 && !/^\d{1,2}[.:]\d{2}/.test(t) && !/^\d+\s+\w/.test(t)) || null;
      const dateM2    = chunk.match(/(\d{2}\.\d{2}\.\d{2,4})/);
      const unread2   = !/notification-item--read|is-read\b|"read"/i.test(chunk);

      items.push({ id: null, title: title2, subtitle: subtitle2, avatar: avatar2, icon: icon2,
                   category: type2, url: url2, date: dateM2?.[1]||null, unread: unread2 });
    }
  }

  return { loggedOut: false, totalCount, items, fetchedAt: new Date().toISOString() };
}

// ── JOYclub Mark-All-Read ─────────────────────────────────────────────────────

async function markJoyclubNotificationsRead(cookieHeader) {
  // Schritt 1: Seite laden um Formular + hidden inputs zu extrahieren
  const { html } = await fetchPageWithCookies('https://www.joyclub.de/benachrichtigung/', cookieHeader);

  // Formular-Action extrahieren (z.B. /benachrichtigung/ oder /benachrichtigung/mark_read/)
  const formM = html.match(/<form[^>]*(?:id="f_notification_mark_read"|action="[^"]*benachrichtigung[^"]*")[^>]*>/i);
  let formAction = '/benachrichtigung/';
  if (formM) {
    const actionM = formM[0].match(/action="([^"]+)"/);
    if (actionM) formAction = actionM[1].startsWith('http') ? actionM[1] : 'https://www.joyclub.de' + actionM[1];
  }

  // Alle hidden inputs aus dem Formular
  const hiddenInputs = {};
  // Alle hidden inputs auf der Seite (inkl. CSRF)
  const inputRe = /<input[^>]+type="hidden"[^>]+>/gi;
  let im;
  while ((im = inputRe.exec(html)) !== null) {
    const nameM  = im[0].match(/name="([^"]+)"/);
    const valueM = im[0].match(/value="([^"]*)"/);
    if (nameM) hiddenInputs[nameM[1]] = valueM ? valueM[1] : '';
  }

  // Schritt 2: POST absenden
  const postData = new URLSearchParams(hiddenInputs);
  // JOYclub-spezifischer Parameter zum Markieren
  postData.set('notification_only_unread', 'false');

  const postBody = Buffer.from(postData.toString(), 'utf8');
  const actionUrl = new URL(formAction.startsWith('http') ? formAction : 'https://www.joyclub.de' + formAction);

  return new Promise((resolve, reject) => {
    const https = require('https');
    const r = https.request({
      hostname: actionUrl.hostname,
      path:     actionUrl.pathname + (actionUrl.search || ''),
      method:   'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type':    'application/x-www-form-urlencoded',
        'Content-Length':  postBody.length,
        'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Referer':         'https://www.joyclub.de/benachrichtigung/',
        'Origin':          'https://www.joyclub.de',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity',
      }
    }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(); reject(new Error('POST Timeout')); });
    r.write(postBody);
    r.end();
  });
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

// Neuen Browser-Tab via CDP Target.createTarget (funktioniert auch ohne /json/new)
async function openNewCDPTab() {
  const browserWsUrl = await getCDPTarget();
  // Wir brauchen die Browser-DevTools-URL, nicht die Page-URL
  // Extrahiere Host aus der Page-wsUrl
  const hostMatch = browserWsUrl.match(/ws:\/\/([^/]+)\//);
  const cdpHost = hostMatch ? hostMatch[1] : null;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(browserWsUrl, { headers: { 'Host': 'localhost' } });
    const timer = setTimeout(() => { ws.close(); reject(new Error('Tab-Create Timeout')); }, 8000);
    let _mid = 0;
    const pending = {};
    ws.on('message', raw => {
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
    ws.on('error', e => { clearTimeout(timer); reject(e); });
    ws.on('open', async () => {
      try {
        // Neuen Tab erstellen
        const r = await new Promise((res2, rej2) => {
          const id = ++_mid;
          pending[id] = { res: res2, rej: rej2 };
          ws.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url: 'about:blank' } }));
        });
        const targetId = r.targetId;
        // WebSocket-URL für neuen Tab aufbauen
        const tabWsUrl = browserWsUrl.replace(/\/devtools\/page\/[^/]+$/, `/devtools/page/${targetId}`)
          .replace(/\/devtools\/browser\/[^/]+$/, `/devtools/page/${targetId}`);
        clearTimeout(timer);
        ws.close();
        resolve({ wsUrl: tabWsUrl, tabId: targetId, browserWsUrl, host: cdpHost });
      } catch(e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });
  });
}

async function closeCDPTab(host, tabId) {
  try {
    const browserWsUrl = await getCDPTarget();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl, { headers: { 'Host': 'localhost' } });
      const timer = setTimeout(() => { ws.close(); resolve(); }, 4000);
      ws.on('message', () => { clearTimeout(timer); ws.close(); resolve(); });
      ws.on('error', () => { clearTimeout(timer); resolve(); });
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Target.closeTarget', params: { targetId: tabId } }));
      });
    });
  } catch(e) { /* ignorieren */ }
}

function getPageUrlViaCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP Timeout')); }, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } }));
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result?.value || '');
      }
    });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ClubMail via CDP – navigiert + extrahiert Konversationsliste per JS aus dem DOM
async function fetchClubMailViaCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const TIMEOUT = 120_000;
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

    ws.on('message', raw => {
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
      timer = setTimeout(() => { ws.close(); reject(new Error('ClubMail CDP Timeout')); }, TIMEOUT);
      try {
        await send('Page.enable');

        // Prüfen ob bereits auf /clubmail/ Liste → DOM direkt auslesen, kein navigate
        // Achtung: /clubmail/12345/ ist Thread-Seite, NICHT die Liste → trotzdem navigieren
        const curR = await send('Runtime.evaluate', { expression: `window.location.href`, returnByValue: true }).catch(() => ({ result: { value: '' } }));
        const curHref = curR.result?.value || '';

        if (!/\/clubmail\/?$/.test(curHref)) {
          await send('Page.navigate', { url: 'https://www.joyclub.de/clubmail/' });
        }

        // Polling bis Konversationsliste MIT Namen erscheint (max 12s)
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 500));
          const chk = await send('Runtime.evaluate', {
            expression: `(function(){
              const entries = document.querySelectorAll('[data-e2e="conversation-list-entry"]');
              for (const e of entries) {
                if (e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim()) return true;
              }
              return false;
            })()`,
            returnByValue: true
          }).catch(() => ({ result: { value: false } }));
          if (chk.result?.value === true) break;
        }
        // Extra-Wartezeit damit Vue alle Slots rendert
        await new Promise(r => setTimeout(r, 800));

        // "Alle" Filter klicken – zeigt alle Konversationen, nicht nur Ungelesene
        const filterRes = await send('Runtime.evaluate', {
          expression: `(function(){
            // Priorität 1: data-e2e Attribut
            var btn = document.querySelector('[data-e2e="filter-all"],[data-e2e="conversation-filter-all"],[data-e2e*="filter-all"],[data-e2e*="all-filter"]');
            // Priorität 2: Text "Alle" in Filter/Tab-Elementen
            if (!btn) {
              var cands = document.querySelectorAll('[class*="filter"] button, [class*="filter"] [role="button"], [class*="tab"] button, [role="tab"], [class*="segment"] button, .cm-conversation-filter button, button[class*="filter"]');
              for (var i = 0; i < cands.length; i++) {
                if (cands[i].textContent.trim() === 'Alle') { btn = cands[i]; break; }
              }
            }
            // Priorität 3: beliebiger Button mit exakt "Alle"
            if (!btn) {
              var allBtns = document.querySelectorAll('button, [role="button"]');
              for (var j = 0; j < allBtns.length; j++) {
                if (allBtns[j].textContent.trim() === 'Alle') { btn = allBtns[j]; break; }
              }
            }
            if (btn) { btn.click(); return 'clicked:' + btn.className.substring(0, 40); }
            return 'not-found';
          })()`,
          returnByValue: true
        }).catch(() => ({ result: { value: 'error' } }));
        const filterClicked = filterRes.result?.value || '';
        console.log('[ClubMail] Filter-Button:', filterClicked);

        // Nach Filter-Klick: warten bis Liste neu geladen ist (max 6s)
        if (filterClicked.startsWith('clicked')) {
          for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 500));
            const chk2 = await send('Runtime.evaluate', {
              expression: `(function(){
                var entries = document.querySelectorAll('[data-e2e="conversation-list-entry"]');
                for (var i = 0; i < entries.length; i++) {
                  if (entries[i].querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim()) return true;
                }
                return false;
              })()`,
              returnByValue: true
            }).catch(() => ({ result: { value: false } }));
            if (chk2.result?.value === true) break;
          }
          // Kurz stabilisieren damit Vue alle Items gerendert hat
          await new Promise(r => setTimeout(r, 600));
        }

        // Unread count aus Nav
        const countRes = await send('Runtime.evaluate', {
          expression: `(function(){
            try {
              const li = document.getElementById('clubmail_notify');
              if (li) {
                const s = li.getAttribute('data-clubmail-state');
                if (s) { const d=JSON.parse(s); return d.unread_conversation_count||0; }
                const b = li.querySelector('.counter_badge');
                if (b) return parseInt(b.textContent)||0;
              }
            } catch(e) {}
            return 0;
          })()`,
          returnByValue: true
        });
        const totalCount = countRes.result?.value || 0;

        // Virtual Scroll Akkumulator: extract + scroll in einer Schleife
        // Virtual Scroll recycelt DOM-Nodes → Namen akkumulieren, nach 3 Leerdurchläufen stoppen
        const itemExtractAndScrollExpr = `(function(){
          try {
            var items = [];
            var entries = document.querySelectorAll('[data-e2e="conversation-list-entry"]');
            for (var i = 0; i < entries.length; i++) {
              var entry = entries[i];
              var nameEl = entry.querySelector('[data-e2e="conversation-list-item-name"]');
              var name = nameEl ? (nameEl.textContent || '').trim() : '';
              if (!name) continue;
              var textEl = entry.querySelector('.cm-conversation-list-item__text');
              var preview = textEl ? (textEl.textContent || '').trim().substring(0, 120) : '';
              var metaEl = entry.querySelector('.cm-conversation-list-item__meta');
              var date = '';
              if (metaEl) {
                for (var j = 0; j < metaEl.childNodes.length; j++) {
                  if (metaEl.childNodes[j].nodeType === 3) {
                    date = (metaEl.childNodes[j].textContent || '').trim();
                    if (date) break;
                  }
                }
              }
              var badgeEl = entry.querySelector('.cm-conversation-list-item__badge') || entry.querySelector('.counter_badge');
              var unreadN = badgeEl ? (parseInt(badgeEl.textContent) || 0) : 0;
              var unread = unreadN > 0;
              var genderEl = entry.querySelector('j-gender-icon');
              var gender = null;
              if (genderEl) {
                var ug = genderEl.getAttribute('universal-gender');
                if (ug === '1') gender = 'Mann';
                else if (ug === '2') gender = 'Frau';
                else if (ug === '3') gender = 'Paar';
                else gender = genderEl.getAttribute('a11y-label') || genderEl.getAttribute('title') || null;
              }
              var avatar = null;
              var pictureEl = entry.querySelector('picture source[srcset]');
              if (pictureEl) {
                var srcset = pictureEl.getAttribute('srcset') || '';
                var parts = srcset.split(',');
                var small = '';
                for (var p = 0; p < parts.length; p++) {
                  if (/120w/.test(parts[p])) { small = parts[p].trim().split(' ')[0]; break; }
                }
                if (!small && parts.length) small = parts[parts.length-1].trim().split(' ')[0];
                avatar = small || null;
              }
              if (!avatar) {
                var imgEl = entry.querySelector('img');
                if (imgEl && imgEl.src && imgEl.src.indexOf('data:') !== 0) avatar = imgEl.src;
              }
              // Konversations-URL aus Entry extrahieren (für direkten Thread-Navigate)
              var convUrl = '';
              var entryLinks = entry.querySelectorAll('a[href], j-a[href]');
              for (var lk = 0; lk < entryLinks.length; lk++) {
                var lh = entryLinks[lk].getAttribute('href') || '';
                if (lh.startsWith('/clubmail/') && lh !== '/clubmail/') { convUrl = lh; break; }
              }
              if (!convUrl) {
                var entryPar = entry.parentElement;
                while (entryPar && entryPar !== document.body) {
                  if (entryPar.tagName === 'A') { var eph = entryPar.getAttribute('href') || ''; if (eph.startsWith('/clubmail/') && eph !== '/clubmail/') { convUrl = eph; break; } }
                  entryPar = entryPar.parentElement;
                }
              }
              // 3. data-* Attribut mit numerischer Konversations-ID
              if (!convUrl) {
                var dk = Object.keys(entry.dataset || {});
                for (var di = 0; di < dk.length; di++) {
                  var dv = entry.dataset[dk[di]];
                  if (/^\d{4,}$/.test(dv)) { convUrl = '/clubmail/' + dv; break; }
                }
              }
              // 4. Avatar-URL: /img/user/{id}/ → /clubmail/{id}
              if (!convUrl) {
                var picEl = entry.querySelector('picture source[srcset]') || entry.querySelector('img');
                if (picEl) {
                  var srcStr = picEl.getAttribute('srcset') || picEl.getAttribute('src') || '';
                  var urlMatch = srcStr.match(/\\/img\\/user\\/(\\d+)\\//);
                  if (urlMatch) convUrl = '/clubmail/' + urlMatch[1];
                }
              }
              items.push({ name: name, date: date, preview: preview, avatar: avatar, unread: unread, unreadN: unreadN, gender: gender, convUrl: convUrl });
            }
            // Nach dem Extrahieren ans Ende scrollen (Virtual Scroll triggern)
            // Mehrere Strategien kombiniert für Vue Virtual Scroll
            if (entries.length) {
              var last = entries[entries.length - 1];
              last.scrollIntoView({ block: 'end', behavior: 'instant' });
              // Strategie 1: Eltern-Container direkt scrollen + scroll-Event feuern
              var sc = last.parentElement;
              while (sc && sc !== document.body) {
                if (sc.scrollHeight > sc.clientHeight + 10) {
                  sc.scrollTop = sc.scrollHeight;
                  sc.dispatchEvent(new Event('scroll', { bubbles: true }));
                  break;
                }
                sc = sc.parentElement;
              }
              // Strategie 2: Klassen-basierte Suche nach dem Scroll-Container
              var cands = document.querySelectorAll('[class*="conversation-list"],[class*="clubmail-list"],[class*="cm-conversation"]');
              for (var ci = 0; ci < cands.length; ci++) {
                if (cands[ci].scrollHeight > cands[ci].clientHeight + 10) {
                  cands[ci].scrollTop = cands[ci].scrollHeight;
                  cands[ci].dispatchEvent(new Event('scroll', { bubbles: true }));
                  break;
                }
              }
              // Strategie 3: Wheel-Event damit Vue Virtual Scroll reagiert
              var wheelTarget = sc || (cands.length ? cands[0] : document.documentElement);
              if (wheelTarget) {
                wheelTarget.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true, cancelable: true }));
                wheelTarget.dispatchEvent(new Event('scroll', { bubbles: true }));
              }
            }
            return JSON.stringify(items);
          } catch(e) {
            return JSON.stringify([]);
          }
        })()`;

        const collectItems = async () => {
          const map = {};
          let emptyRuns = 0;
          for (let s = 0; s < 80; s++) {
            const batchRes = await send('Runtime.evaluate', { expression: itemExtractAndScrollExpr, returnByValue: true })
              .catch(() => ({ result: { value: '[]' } }));
            let batchItems = [];
            try { batchItems = JSON.parse(batchRes.result?.value || '[]'); } catch(e) {}
            let newCount = 0;
            for (const item of batchItems) {
              if (item.name && !map[item.name]) {
                map[item.name] = item;
                newCount++;
              } else if (item.name && map[item.name]) {
                if (!map[item.name].gender && item.gender) map[item.name].gender = item.gender;
                if (!map[item.name].avatar && item.avatar) map[item.name].avatar = item.avatar;
                if (!map[item.name].convUrl && item.convUrl) map[item.name].convUrl = item.convUrl;
              }
            }
            if (s > 0 && newCount === 0) emptyRuns++;
            else emptyRuns = 0;
            if (emptyRuns >= 5) break;
            if (s % 10 === 9) console.log('[ClubMail] Scroll', s + 1, '– gesammelt:', Object.keys(map).length);
            await new Promise(r => setTimeout(r, 500));
          }
          console.log('[ClubMail] Gesamt gesammelt:', Object.keys(map).length);
          return map;
        };

        let allItemsMap = await collectItems();

        // Retry: Liste leer → frisch navigieren und nochmal warten
        if (Object.keys(allItemsMap).length === 0) {
          await send('Page.navigate', { url: 'https://www.joyclub.de/clubmail/' });
          for (let i = 0; i < 16; i++) {
            await new Promise(r => setTimeout(r, 500));
            const chk = await send('Runtime.evaluate', {
              expression: `(function(){var e=document.querySelectorAll('[data-e2e="conversation-list-entry"]');for(var i=0;i<e.length;i++){if(e[i].querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim())return true;}return false;})()`,
              returnByValue: true
            }).catch(() => ({ result: { value: false } }));
            if (chk.result?.value === true) break;
          }
          await new Promise(r => setTimeout(r, 800));
          allItemsMap = await collectItems();
        }

        // Eingeloggten User erkennen: Profil-Link im JOYclub-Nav lesen
        const PROFILE_NAMES = { '9612457': 'Tobi', '9587483': 'Kristina' };
        let senderName = null;
        try {
          const profileRes = await send('Runtime.evaluate', {
            expression: `(function(){
              for (var a of document.querySelectorAll('a[href*="/profile/"]')) {
                var m = a.href.match(/\/profile\/(\d+)/);
                if (m) return m[1];
              }
              return null;
            })()`,
            returnByValue: true
          }).catch(() => ({ result: { value: null } }));
          const profileId = profileRes.result?.value || null;
          senderName = profileId ? (PROFILE_NAMES[profileId] || null) : null;
          if (senderName) console.log('[ClubMail] Eingeloggt als:', senderName, '(Profil-ID:', profileId + ')');
        } catch(e) { /* ignorieren */ }

        clearTimeout(timer);
        ws.close();

        const items = Object.values(allItemsMap).map(i => {
          // Server-seitigen URL-Cache befüllen für schnelles Thread-Laden
          if (i.convUrl) convUrlCache.set(i.name, i.convUrl);
          return {
          id:      i.name,
          url:     i.convUrl ? 'https://www.joyclub.de' + i.convUrl : 'https://www.joyclub.de/clubmail/',
          name:    i.name,
          preview: i.preview,
          avatar:  i.avatar,
          date:    i.date || null,
          unread:  i.unread,
          unreadN: i.unreadN || 0,
          gender:  i.gender || null,
          };
        });

        resolve({ loggedOut: false, totalCount, items, senderName, fetchedAt: new Date().toISOString() });
      } catch(err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ClubMail Thread via CDP – navigiert direkt per URL (wenn bekannt) oder über Liste
async function fetchClubMailThreadViaCDP(wsUrl, convId, convName, convUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
    const TIMEOUT = 50_000;
    let timer;
    let _mid = 0;
    const pending = {};

    const send = (method, params = {}) => {
      const id = ++_mid;
      return new Promise((res, rej) => {
        pending[id] = { res, rej };
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    // Network-Interception: Bild-URLs aus JOYclub-Requests abgreifen
    // JOYclub lädt Bilder lazy via JS – sie erscheinen NIE im DOM-Attribut.
    // Stattdessen feuert Chrome ein Network.requestWillBeSent wenn das Bild geladen wird.
    const interceptedImages = []; // Gesammelte echte Chat-Bild-URLs
    // Strict: nur echte Message-Attachments via Download-API (attachment_id=N)
    // image_\d+_ matcht leider auch Profilbilder → weglassen
    const CHAT_IMAGE_RE = /attachment_id=\d+/i;

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw);
        // Network-Event: Bild-Request abfangen
        if (msg.method === 'Network.requestWillBeSent') {
          const reqUrl = msg.params?.request?.url || '';
          // Debug: alle joyclub.de Bild-ähnlichen Requests loggen
          if (reqUrl.includes('joyclub') && /\.(webp|jpg|jpeg|png)|attachment_id=|image_\d/i.test(reqUrl)) {
            const matches = CHAT_IMAGE_RE.test(reqUrl);
            console.log(`[IMG-DEBUG] ${matches ? 'CHAT-IMG' : 'skip'} – ${reqUrl.substring(0, 120)}`);
          }
          // Nur echte Chat-Attachment-URLs sammeln (kein UI-Dekor wie up.png, cm_image_hint.jpg)
          if (CHAT_IMAGE_RE.test(reqUrl) && !reqUrl.includes('1x1') &&
              !/avatar|profile|icon|emoji/i.test(reqUrl) && reqUrl.length > 30) {
            if (!interceptedImages.includes(reqUrl)) interceptedImages.push(reqUrl);
          }
        }
        if (msg.id && pending[msg.id]) {
          const { res, rej } = pending[msg.id];
          delete pending[msg.id];
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      } catch(e) {}
    });

    // Nachrichten aus dem gerenderten Thread extrahieren
    const extractExpr = `(function(){
      // Light-DOM + Shadow-DOM Suche (j-message-bubble ist Lit-Komponente mit shadowRoot)
      function qSel(host, sel) {
        if (!host) return null;
        try {
          var r = host.querySelector(sel);
          if (r) return r;
          if (host.shadowRoot) return host.shadowRoot.querySelector(sel);
        } catch(e) {}
        return null;
      }

      // Rekursiver DOM-Walker: Absätze, BR, Links, Bold korrekt verarbeiten
      function walkNode(n) {
        if (n.nodeType === 3) return n.textContent;
        if (n.nodeName === 'BR') return '\\n';
        if (['P','DIV','SECTION','ARTICLE','H1','H2','H3','H4','H5','H6'].includes(n.nodeName)) {
          const inner = Array.from(n.childNodes).map(walkNode).join('').trim();
          return inner ? '\\n' + inner + '\\n' : '';
        }
        if (n.nodeName === 'A') {
          const href = n.href || '';
          const text = n.textContent?.trim() || href;
          return href ? '[LINK:' + href + ':' + text + ']' : text;
        }
        if (n.nodeName === 'J-A') {
          const href = n.getAttribute('href') || n.getAttribute('to') || '';
          const text = n.textContent?.trim() || href;
          const full = href.startsWith('http') ? href : ('https://www.joyclub.de' + href);
          return href ? '[LINK:' + full + ':' + text + ']' : text;
        }
        if (['STRONG','B'].includes(n.nodeName)) {
          return '**' + Array.from(n.childNodes).map(walkNode).join('') + '**';
        }
        return Array.from(n.childNodes).map(walkNode).join('');
      }

      // Primär: .cm-message-bubble__content (BEM-Element, direkt im Bubble-Container)
      // Struktur: <div class="cm-message-bubble cm-message-bubble--right">
      //             <div class="cm-message-bubble__content">text + footer>time</div>
      //           </div>
      let bubbles = document.querySelectorAll('.cm-message-bubble__content');
      if (!bubbles || !bubbles.length) {
        // Fallback 1: container direkt (falls __content fehlt)
        bubbles = document.querySelectorAll('[class*="cm-message-bubble--right"],[class*="cm-message-bubble--left"]');
      }
      if (!bubbles || !bubbles.length) {
        // Fallback 2: data-e2e
        bubbles = document.querySelectorAll('[data-e2e$="-message"]');
      }
      if (!bubbles || !bubbles.length) return JSON.stringify({ count: 0, path: window.location.pathname });
      const messages = [];
      bubbles.forEach(el => {
        const onlyLinks = el.textContent?.trim().length < 5 && el.querySelector('j-a, a[href]');
        if (onlyLinks) return;
        let text = walkNode(el);
        text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
        // Fallback: innerText (Chrome rendert Shadow DOM) → textContent → überspringen
        if (!text) text = (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n').replace(/[ \\t]+/g, ' ').trim();

        // Outer-Bubble für own/other: --right = eigen, --left = fremd
        const wrap = el.closest('[class*="cm-message-bubble--right"],[class*="cm-message-bubble--left"]')
                  || el.closest('[data-e2e$="-message"]')
                  || el.closest('[class*="cm-message-bubble"]');
        const wCls = wrap ? (wrap.getAttribute('class') || '') : '';
        const own = wCls.includes('cm-message-bubble--right')
                 || (wrap ? wrap.getAttribute('data-e2e') === 'sent-message' : false);

        // j-message-bubble = Lit Custom Element, hat shadowRoot mit footer>time drin
        const jBubble = el.closest('j-message-bubble') || wrap?.closest('j-message-bubble');
        const jShadow = jBubble ? jBubble.shadowRoot : null;
        // li[data-message-id] = äußerster Container pro Nachricht
        const liItem = el.closest('[data-message-id]');

        // Bild-Anhang erkennen (slot="media" / cm-message-bubble_attachment)
        var isImage = false;
        var imageUrl = '';
        var _container = liItem || wrap;
        if (_container) {
          var _att = _container.querySelector('[slot="media"], .cm-message-bubble_attachment, .cm-message-attachment');
          if (_att) {
            isImage = true;
            var _prev = _container.querySelector('.cm-message-attachment__preview, [class*="attachment__preview"]');
            if (_prev) {
              // 1) src-Attribut direkt am div (JOYclub setzt src="" auf dem Preview-div)
              var _pvSrc = _prev.getAttribute('src') || '';
              if (_pvSrc.length > 20 && !_pvSrc.includes('1x1') && !_pvSrc.startsWith('data:')) imageUrl = _pvSrc;
              // 2) background-image (inline style oder computed)
              if (!imageUrl) {
                var _bg = (_prev.style && _prev.style.backgroundImage) || '';
                if (!_bg) { try { _bg = window.getComputedStyle(_prev).backgroundImage || ''; } catch(e) {} }
                var _bgm = _bg.match(/url\\(["']?([^"')]+)["']?\\)/);
                if (_bgm) imageUrl = _bgm[1];
              }
              // 3) img-Kind mit echter URL
              if (!imageUrl) {
                var _pvImg = _prev.querySelector('img[src]');
                if (_pvImg) { var _pvS = _pvImg.getAttribute('src')||''; if (_pvS.length>20&&!_pvS.includes('1x1')&&!_pvS.startsWith('data:image/gif')) imageUrl=_pvS; }
              }
            }
            if (!imageUrl) {
              var _imgEl = _container.querySelector('img:not([class*="avatar"]):not([class*="profile"]):not([class*="icon"])');
              if (_imgEl) {
                var _dataSrcAttrs = ['data-src','data-full-src','data-lazy-src','data-original','src'];
                for (var _dai = 0; _dai < _dataSrcAttrs.length; _dai++) {
                  var _dv = _imgEl.getAttribute(_dataSrcAttrs[_dai]) || '';
                  if (_dv.length > 20 && !_dv.includes('1x1') && !_dv.startsWith('data:image/gif')) {
                    imageUrl = _dv; break;
                  }
                }
              }
            }
            if (!text) text = '[Foto]';
          }
        }
        if (!text) return;

        // Datum/Zeit: ISO-Timestamp (datetime*="T") – Datums-Separator (kein T) überspringen
        function findIsoTime(root) {
          if (!root) return null;
          return root.querySelector('time[datetime*="T"]') || null;
        }
        const timeEl = findIsoTime(el)
                    || findIsoTime(el.parentElement)
                    || (jShadow ? findIsoTime(jShadow) : null)
                    || findIsoTime(wrap)
                    || findIsoTime(liItem);
        let date = '';
        if (timeEl) {
          const dt = timeEl.getAttribute('datetime') || '';
          try {
            const d = new Date(dt);
            date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' +
                   d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          } catch(e) { date = timeEl.textContent?.trim() || ''; }
        }

        const isKompliment = /kompliment/i.test(wCls) || /Kompliment/i.test(text.substring(0,50));

        // Sender: nur bei fremden Nachrichten
        let sender = '';
        if (!own) {
          function findSender(root) {
            if (!root) return null;
            return root.querySelector('[class*="bubble__sender"],[class*="sender-name"],[class*="sender"],[class*="username"],[class*="nickname"]') || null;
          }
          const senderEl = findSender(el)
                        || (jShadow ? findSender(jShadow) : null)
                        || findSender(wrap)
                        || findSender(liItem);
          sender = senderEl ? senderEl.textContent.trim() : '';
        }

        const _liId = liItem ? liItem.getAttribute('data-message-id') : '';
        messages.push({ text: text.substring(0, 2000), own, date, isKompliment, sender, isImage, imageUrl, _liId });
      });

      // Zweiter Pass: Bild-only Nachrichten ohne __content (slot="media" standalone)
      var _processedLiIds = new Set(messages.map(function(m){ return m._liId; }).filter(Boolean));
      document.querySelectorAll('[slot="media"]').forEach(function(imgC) {
        var _li = imgC.closest('[data-message-id]');
        var _lid = _li ? _li.getAttribute('data-message-id') : '';
        if (_lid && _processedLiIds.has(_lid)) return;
        var _wr = imgC.closest('[class*="cm-message-bubble--right"],[class*="cm-message-bubble--left"]') || imgC.closest('[class*="cm-message-bubble"]');
        var _wc = _wr ? (_wr.getAttribute('class') || '') : '';
        var _own = _wc.includes('cm-message-bubble--right');
        var _jb = imgC.closest('j-message-bubble');
        var _js = _jb ? _jb.shadowRoot : null;
        var _te = (_li && _li.querySelector('time[datetime*="T"]'))
               || (_js && _js.querySelector('time[datetime*="T"]'))
               || (_wr && _wr.querySelector('time[datetime*="T"]'));
        var _date = '';
        if (_te) {
          try {
            var _d = new Date(_te.getAttribute('datetime'));
            _date = _d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}) + ' ' +
                    _d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
          } catch(e) {}
        }
        var _imgUrl = '';
        var _pv = imgC.querySelector('.cm-message-attachment__preview, [class*="attachment__preview"]') || imgC;
        if (_pv) {
          var _pvSrc2 = _pv.getAttribute('src') || '';
          if (_pvSrc2.length > 20 && !_pvSrc2.includes('1x1') && !_pvSrc2.startsWith('data:')) { _imgUrl = _pvSrc2; }
          if (!_imgUrl) {
            var _bg2 = (_pv.style && _pv.style.backgroundImage) || '';
            if (!_bg2) { try { _bg2 = window.getComputedStyle(_pv).backgroundImage || ''; } catch(e) {} }
            var _bgm2 = _bg2.match(/url\\(["']?([^"')]+)["']?\\)/);
            if (_bgm2) _imgUrl = _bgm2[1];
          }
          if (!_imgUrl) {
            var _pvImg2 = _pv.querySelector('img[src]') || imgC.querySelector('img[src]');
            if (_pvImg2) { var _pvS2 = _pvImg2.getAttribute('src')||''; if (_pvS2.length>20&&!_pvS2.includes('1x1')&&!_pvS2.startsWith('data:image/gif')) _imgUrl=_pvS2; }
          }
        }
        messages.push({ text: '[Foto]', own: _own, date: _date, isKompliment: false, sender: '', isImage: true, imageUrl: _imgUrl, _liId: _lid });
        if (_lid) _processedLiIds.add(_lid);
      });
      // Dritter Pass: JOYclub "protected picture-ui" – img.img-pane mit 1×1 GIF-Platzhalter
      // Diese Bilder landen NICHT in slot="media", sondern in div.protected.picture-ui
      document.querySelectorAll('[data-message-id]').forEach(function(li) {
        var _lid = li.getAttribute('data-message-id') || '';
        if (_lid && _processedLiIds.has(_lid)) return;
        var picUi = li.querySelector('.protected.picture-ui, div[class*="picture-ui"]');
        if (!picUi) return;
        var _wr = li.querySelector('[class*="cm-message-bubble--right"],[class*="cm-message-bubble--left"]') || li.querySelector('[class*="cm-message-bubble"]');
        var _own = _wr ? (_wr.getAttribute('class') || '').includes('cm-message-bubble--right') : false;
        var _te = li.querySelector('time[datetime*="T"]');
        var _date = '';
        if (_te) {
          try {
            var _d3 = new Date(_te.getAttribute('datetime'));
            _date = _d3.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}) + ' ' +
                    _d3.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
          } catch(e) {}
        }
        // Versuche echte Bild-URL aus computed background-image des simple-picture div
        var _imgUrl = '';
        var _sp = picUi.querySelector('.simple-picture, [class*="simple-picture"]');
        if (_sp) {
          var _bg3 = (_sp.style && _sp.style.backgroundImage) || '';
          if (!_bg3) { try { _bg3 = window.getComputedStyle(_sp).backgroundImage || ''; } catch(e) {} }
          var _bgm3 = _bg3.match(/url\(["']?([^"')]+)["']?\)/);
          if (_bgm3) _imgUrl = _bgm3[1];
        }
        messages.push({ text: '[Foto]', own: _own, date: _date, isKompliment: false, sender: '', isImage: true, imageUrl: _imgUrl, _liId: _lid });
        if (_lid) _processedLiIds.add(_lid);
      });
      // Vierter Pass: Breit-Fallback – jedes unverarbeitete [data-message-id] mit Bild-Indikator
      // Fängt neue JOYclub-Komponenten (<cm-message-picture>, <j-image>, etc.) und direkte <img>-Tags ab
      document.querySelectorAll('[data-message-id]').forEach(function(li) {
        var _lid4 = li.getAttribute('data-message-id') || '';
        if (_lid4 && _processedLiIds.has(_lid4)) return;
        // Prüfen ob Bild vorhanden: img-Tag mit echter URL ODER Element mit Bild-Klassen ODER custom element
        var hasImg = false;
        var _imgUrl4 = '';
        // Hilfsfunktion: URL aus src/data-src/data-full-src/data-lazy-src oder background-image
        function extractImgUrl4(el) {
          if (!el) return '';
          var attrs = ['src','data-src','data-full-src','data-lazy-src','data-original','data-url'];
          for (var _a = 0; _a < attrs.length; _a++) {
            var _v = el.getAttribute(attrs[_a]) || '';
            if (_v.length > 20 && !_v.includes('1x1') && !_v.startsWith('data:image/gif')) return _v;
          }
          // background-image: url(...)
          var _bg = (el.style && el.style.backgroundImage) || '';
          if (!_bg) { try { _bg = window.getComputedStyle(el).backgroundImage || ''; } catch(e) {} }
          var _bgm = _bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (_bgm && _bgm[1].length > 20 && !_bgm[1].includes('1x1')) return _bgm[1];
          return '';
        }
        // 1) img-Tags: src oder data-src (JOYclub lazy-loads mit data-src)
        var _imgs = li.querySelectorAll('img');
        for (var _ii = 0; _ii < _imgs.length; _ii++) {
          var _url4 = extractImgUrl4(_imgs[_ii]);
          if (_url4) { hasImg = true; _imgUrl4 = _url4; break; }
        }
        // 2) Element mit Bild-Klassen (media, picture, image, photo, attachment) oder Bild-Custom-Elements
        if (!hasImg) {
          var _imgEl4 = li.querySelector('[class*="media"],[class*="picture"],[class*="image"],[class*="photo"],[class*="attachment"],cm-message-picture,j-image,cm-picture,[data-e2e*="image"],[data-e2e*="photo"]');
          if (_imgEl4) {
            hasImg = true;
            _imgUrl4 = extractImgUrl4(_imgEl4);
          }
        }
        if (!hasImg) return;
        // own-Erkennung: --right = eigene Nachricht; data-e2e="sent-message"; Fallback: false (eingehend)
        var _liCls4 = li.getAttribute('class') || '';
        var _wr4 = li.querySelector('[class*="--right"],[class*="--left"],[data-e2e="sent-message"],[data-e2e="received-message"]') || li.querySelector('[class*="cm-message-bubble"]');
        var _own4 = _liCls4.includes('--right')
          || (li.getAttribute('data-e2e') === 'sent-message')
          || (_wr4 ? ((_wr4.getAttribute('class') || '').includes('--right') || _wr4.getAttribute('data-e2e') === 'sent-message') : false);
        var _te4 = li.querySelector('time[datetime*="T"]');
        var _date4 = '';
        if (_te4) {
          try {
            var _d4 = new Date(_te4.getAttribute('datetime'));
            _date4 = _d4.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}) + ' ' +
                     _d4.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
          } catch(e) {}
        }
        messages.push({ text: '[Foto]', own: _own4, date: _date4, isKompliment: false, sender: '', isImage: true, imageUrl: _imgUrl4, _liId: _lid4 });
        if (_lid4) _processedLiIds.add(_lid4);
      });

      // _liId aus Output entfernen
      messages.forEach(function(m){ delete m._liId; });

      // Debug: Struktur des ersten Bubble-Elements analysieren
      var _debug = null;
      if (bubbles.length > 0) {
        var _el = bubbles[0];
        var _wrap = _el.closest('[class*="cm-message-bubble--right"],[class*="cm-message-bubble--left"]') || _el.closest('[class*="cm-message-bubble"]');
        var _allIsoTimes = document.querySelectorAll('time[datetime*="T"]').length;
        var _jBubble = _el.closest('j-message-bubble') || _wrap?.closest('j-message-bubble');
        var _jShadow = _jBubble ? _jBubble.shadowRoot : null;
        var _liItem = _el.closest('[data-message-id]');
        _debug = {
          selector: _el.tagName + '.' + (_el.getAttribute('class')||'').split(' ').join('.'),
          wrapCls: _wrap ? (_wrap.getAttribute('class')||'') : 'no wrap',
          hasJBubble: !!_jBubble,
          jShadowHtml: _jShadow ? (_jShadow.innerHTML||'').substring(0,400) : null,
          lightInner: (_el.innerHTML||'').substring(0,300),
          timeInEl: !!_el.querySelector('time[datetime*="T"]'),
          timeInParent: !!(_el.parentElement && _el.parentElement.querySelector('time[datetime*="T"]')),
          timeInJShadow: !!(_jShadow && _jShadow.querySelector('time[datetime*="T"]')),
          timeInWrap: !!(_wrap && _wrap.querySelector('time[datetime*="T"]')),
          timeInLi: !!(_liItem && _liItem.querySelector('time[datetime*="T"]')),
          allIsoTimesInPage: _allIsoTimes
        };
      }
      // Debug: Foto-Detection Statistik
      var _imgStats = {
        msgTotal: messages.length,
        msgWithImage: messages.filter(function(m){ return m.isImage; }).length,
        slotMediaCount: document.querySelectorAll('[slot="media"]').length,
        pictureUiCount: document.querySelectorAll('.protected.picture-ui, [class*="picture-ui"]').length,
        dataMessageIdCount: document.querySelectorAll('[data-message-id]').length
      };
      return JSON.stringify({ count: messages.length, messages, path: window.location.pathname, _debug, _imgStats });
    })()`;

    ws.on('open', async () => {
      timer = setTimeout(() => { ws.close(); reject(new Error('Thread CDP Timeout')); }, TIMEOUT);
      try {
        await send('Page.enable');
        await send('Network.enable'); // Nötig für Network.requestWillBeSent Events (Bild-URLs)

        // Fetch-Interceptor injizieren: fängt attachment_id-URLs im JS-Kontext ab
        // (zuverlässiger als Network.requestWillBeSent – funktioniert auch bei Browser-Cache-Hits)
        await send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(function(){
            window.__f3AttachmentUrls = [];
            window.__f3FetchCount = 0;
            // fetch() interceptieren
            var _origFetch = window.fetch;
            window.__f3FetchLog = [];
            window.fetch = function(input, init) {
              window.__f3FetchCount++;
              var url = (typeof input === 'string') ? input : (input && input.url) || '';
              window.__f3FetchLog.push(url.substring(0, 120));
              if (url && url.includes('attachment_id=') && !window.__f3AttachmentUrls.includes(url))
                window.__f3AttachmentUrls.push(url);
              return _origFetch.apply(this, arguments);
            };
            // XMLHttpRequest interceptieren (falls JOYclub XHR statt fetch nutzt)
            var _origXHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
              if (url && url.includes('attachment_id=') && !window.__f3AttachmentUrls.includes(url))
                window.__f3AttachmentUrls.push(url);
              return _origXHROpen.apply(this, arguments);
            };
          })();`
        }).catch(() => {}); // ignorieren wenn nicht verfügbar

        const nameToFind = convName || convId;

        // Hilfsfunktion: Warte auf Message-Bubbles – prüft korrekte Bubble-Selektoren
        const bubbleCheck = `(function(){
          var sels = ['[class*="cm-message-bubble--right"]','[class*="cm-message-bubble--left"]','[data-e2e$="-message"]'];
          for(var s=0;s<sels.length;s++){if(document.querySelectorAll(sels[s]).length>0)return true;}
          return false;
        })()`;
        const waitForBubbles = async (maxMs) => {
          const steps = Math.ceil(maxMs / 600);
          for (let i = 0; i < steps; i++) {
            await new Promise(r => setTimeout(r, 600));
            const c = await send('Runtime.evaluate', { expression: bubbleCheck, returnByValue: true })
              .catch(() => ({ result: { value: false } }));
            if (c.result?.value === true) return true;
          }
          return false;
        };

        // Hilfsfunktion: interceptedImages in Nachrichten einfüllen (Reihenfolge = Lade-Reihenfolge)
        const applyInterceptedImages = (messages) => {
          let idx = 0;
          for (const msg of (messages || [])) {
            if (msg.isImage && !msg.imageUrl && idx < interceptedImages.length) {
              msg.imageUrl = interceptedImages[idx++];
              console.log('[Thread] Bild-URL via Network-Interception:', msg.imageUrl.substring(0, 80));
            }
          }
        };

        // Hilfsfunktion: attachment_id URLs direkt im Browser fetchen → data URL
        // Quellen: interceptedImages (Network-Events) ODER window.__f3AttachmentUrls (Fetch-Interceptor)
        const fetchAttachmentsInBrowser = async (messages) => {
          const imgMsgs = (messages || []).filter(m => m.isImage);
          // Diagnoselog: was haben wir?
          console.log('[IMG] fetchAttachmentsInBrowser: isImage-Msgs=', imgMsgs.length,
            '| interceptedImages=', interceptedImages.length,
            '| msgs ohne URL=', imgMsgs.filter(m=>!m.imageUrl).length);

          // Alle bekannten attachment_id-URLs sammeln (Network-Interception + JS-Interceptor)
          let pageUrls = [];
          try {
            const pu = await send('Runtime.evaluate', {
              expression: `JSON.stringify({ urls: window.__f3AttachmentUrls || [], fetchCount: window.__f3FetchCount || 0, fetchLog: window.__f3FetchLog || [] })`,
              returnByValue: true,
            });
            const pd = JSON.parse(pu.result?.value || '{}');
            pageUrls = pd.urls || [];
            console.log('[IMG] __f3AttachmentUrls=', pageUrls.length, '| __f3FetchCount=', pd.fetchCount);
            if (pd.fetchLog?.length) console.log('[IMG] fetch-URLs:', JSON.stringify(pd.fetchLog));
          } catch(e) { console.log('[IMG] Runtime.evaluate Fehler:', e.message); }

          for (const m of (messages || [])) {
            // Fehlende imageUrl aus JS-Interceptor befüllen
            if (m.isImage && !m.imageUrl && pageUrls.length > 0) {
              m.imageUrl = pageUrls.shift();
              console.log('[Thread] Attachment-URL via JS-Interceptor:', m.imageUrl.substring(0, 80));
            }
            // Sicherheitsnetz: falls m.imageUrl ein Screenshot ist (data:) aber es gibt
            // noch ungenutzte interceptedImages → echte attachment_id URL bevorzugen
            if (m.isImage && m.imageUrl?.startsWith('data:') && interceptedImages.length > 0) {
              const unusedUrl = interceptedImages.find(u => u.includes('attachment_id='));
              if (unusedUrl) {
                console.log('[Thread] Screenshot durch Network-URL ersetzt:', unusedUrl.substring(0, 80));
                m.imageUrl = unusedUrl;
              }
            }
            if (!m.imageUrl || !m.imageUrl.includes('attachment_id=')) continue;
            // URL als data URL via Browser-Fetch laden
            try {
              const fbRes = await send('Runtime.evaluate', {
                expression: `(async function(){
                  try {
                    var res = await fetch(${JSON.stringify(m.imageUrl)}, {credentials:'include'});
                    if (!res.ok) return 'err:'+res.status;
                    var ab = await res.arrayBuffer();
                    var bytes = new Uint8Array(ab);
                    var chunks = [], cs = 8192;
                    for (var i = 0; i < bytes.length; i += cs)
                      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i+cs,bytes.length))));
                    return 'data:'+(res.headers.get('content-type')||'image/jpeg')+';base64,'+btoa(chunks.join(''));
                  } catch(e) { return 'err:'+e.message; }
                })()`,
                awaitPromise: true,
                returnByValue: true,
              });
              const val = fbRes.result?.value || '';
              if (val.startsWith('data:')) {
                m.imageUrl = val;
                console.log('[Thread] Attachment via Browser-Fetch (' + Math.round(val.length/1024) + 'KB)');
              } else {
                console.log('[Thread] Browser-Fetch failed:', val.substring(0, 60));
              }
            } catch(e) { console.log('[Thread] Browser-Fetch error:', e.message); }
          }
        };

        // Priorität 1: convUrlCache (server-seitig) oder URL-Parameter → direkt navigieren
        const cachedUrl = convUrlCache.get(nameToFind);
        const urlParam = (convUrl && convUrl !== 'https://www.joyclub.de/clubmail/' && convUrl !== '/clubmail/')
          ? convUrl : null;
        const urlToTry = cachedUrl || urlParam;
        if (urlToTry && urlToTry !== '/clubmail/' && urlToTry.includes('/clubmail/')) {
          const fullUrl = urlToTry.startsWith('http') ? urlToTry : 'https://www.joyclub.de' + urlToTry;
          await send('Page.navigate', { url: fullUrl });
          if (await waitForBubbles(9000)) {
            // Warten: attachment_id-URL kommt oft erst beim Lazy-Render
            await new Promise(r => setTimeout(r, 1800));
            const r = await send('Runtime.evaluate', { expression: extractExpr, returnByValue: true });
            let result = {}; try { result = JSON.parse(r.result?.value || '{}'); } catch(e) {}
            if (result.count) {
              applyInterceptedImages(result.messages);
              await fetchAttachmentsInBrowser(result.messages);
              clearTimeout(timer); ws.close();
              return resolve({ messages: result.messages || [], debugInfo: result });
            }
          }
          // Bubbles nicht erschienen → Cache ungültig, Fallback auf Listennavigation
          convUrlCache.delete(nameToFind);
        }

        // Priorität 2: numerische convId → /clubmail/conversation/{id}
        const isNumericId = /^\d+$/.test(String(convId));
        if (isNumericId) {
          await send('Page.navigate', { url: `https://www.joyclub.de/clubmail/conversation/${convId}` });
          // Warten bis Bubbles erscheinen (max 12s)
          let bubblesDirect = false;
          for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 500));
            const chk = await send('Runtime.evaluate', {
              expression: `document.querySelectorAll('[class*="cm-message-bubble--right"],[class*="cm-message-bubble--left"],[data-e2e$="-message"]').length`,
              returnByValue: true
            }).catch(() => ({ result: { value: 0 } }));
            if ((chk.result?.value || 0) > 0) { bubblesDirect = true; break; }
          }
          if (bubblesDirect) {
            // Warten: attachment_id-URL kommt oft erst beim Lazy-Render
            await new Promise(r => setTimeout(r, 1800));
            const r = await send('Runtime.evaluate', { expression: extractExpr, returnByValue: true });
            let result = {}; try { result = JSON.parse(r.result?.value || '{}'); } catch(e) {}
            applyInterceptedImages(result.messages);
            await fetchAttachmentsInBrowser(result.messages);
            clearTimeout(timer); ws.close();
            return resolve({ messages: result.messages || [], debugInfo: result });
          }
          // Fallback: weiter mit Listen-Navigation
        }

        // 1. Zur Konversationsliste navigieren + auf Listeneinträge warten
        await send('Page.navigate', { url: 'https://www.joyclub.de/clubmail/' });
        let listReady = false;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const chk = await send('Runtime.evaluate', {
            expression: `document.querySelectorAll('[data-e2e="conversation-list-entry"]').length`,
            returnByValue: true
          }).catch(() => ({ result: { value: 0 } }));
          if ((chk.result?.value || 0) > 0) { listReady = true; break; }
        }
        if (!listReady) throw new Error('ClubMail-Liste nicht geladen');

        // 2. Eintrag finden: URL extrahieren (direkte Navigation bevorzugt) + Fallback Klick
        const entryRes = await send('Runtime.evaluate', {
          expression: `(function(){
            var entries = document.querySelectorAll('[data-e2e="conversation-list-entry"]');
            for (var i = 0; i < entries.length; i++) {
              var e = entries[i];
              var n = e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim();
              if (n !== ${JSON.stringify(nameToFind)}) continue;
              e.scrollIntoView({ block: 'center' });
              // 1. Child <a href> oder j-a[href]
              var links = e.querySelectorAll('a[href], j-a[href]');
              for (var j = 0; j < links.length; j++) {
                var h = links[j].getAttribute('href') || '';
                if (h.startsWith('/clubmail/') && h !== '/clubmail/') return JSON.stringify({ url: h });
              }
              // 2. Parent <a href>
              var par = e.parentElement;
              while (par && par !== document.body) {
                if (par.tagName === 'A') { var ph = par.getAttribute('href'); if (ph && ph.startsWith('/clubmail/') && ph !== '/clubmail/') return JSON.stringify({ url: ph }); }
                par = par.parentElement;
              }
              // 3. Avatar /img/user/{id}/ → /clubmail/{id}
              var img = e.querySelector('picture source[srcset]') || e.querySelector('img');
              if (img) {
                var src = img.getAttribute('srcset') || img.getAttribute('src') || '';
                var m = src.match(/\\/img\\/user\\/(\\d+)\\//);
                if (m) return JSON.stringify({ url: '/clubmail/' + m[1] });
              }
              // 4. Kein URL – JS-click als Fallback, Koordinaten für Mouse-Event
              var r = e.getBoundingClientRect();
              e.click();
              return JSON.stringify({ clicked: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
            }
            var allNames = Array.from(entries).map(e => e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim()).filter(Boolean);
            return JSON.stringify({ notFound: true, names: allNames.slice(0,8) });
          })()`,
          returnByValue: true
        });
        let entryInfo = {};
        try { entryInfo = JSON.parse(entryRes.result?.value || '{}'); } catch(e) {}

        if (entryInfo.notFound) throw new Error('Eintrag nicht gefunden: ' + nameToFind + ' (verfügbar: ' + (entryInfo.names||[]).join(', ') + ')');

        // 3. Navigation: direkt per URL (zuverlässiger) oder Maus-Fallback
        if (entryInfo.url) {
          convUrlCache.set(nameToFind, entryInfo.url); // für spätere Requests cachen
          await send('Page.navigate', { url: 'https://www.joyclub.de' + entryInfo.url });
        } else if (entryInfo.clicked) {
          // JS-click wurde schon ausgelöst, zusätzlich Mouse-Event senden
          await new Promise(r => setTimeout(r, 200));
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: entryInfo.x || 100, y: entryInfo.y || 200, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: entryInfo.x || 100, y: entryInfo.y || 200, button: 'left', clickCount: 1 });
        }

        // 4. Auf URL-Änderung warten (Vue Router navigiert zu /clubmail/:id/)
        let threadUrl = '';
        for (let i = 0; i < 14; i++) {
          await new Promise(r => setTimeout(r, 500));
          const r = await send('Runtime.evaluate', { expression: `window.location.pathname`, returnByValue: true });
          const p = r.result?.value || '';
          if (p.startsWith('/clubmail/') && p !== '/clubmail/') { threadUrl = p; break; }
        }

        // 5. Warten bis Nachrichten gerendert sind
        if (threadUrl) {
          await new Promise(r => setTimeout(r, 3000));
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }

        // 6. Nachrichten extrahieren (mit 1 Retry)
        let parsed = { count: 0, messages: [] };
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
          const res = await send('Runtime.evaluate', { expression: extractExpr, returnByValue: true });
          try { parsed = JSON.parse(res.result?.value || '{}'); } catch(e) {}
          if (parsed.count) break;
        }

        // 6b. Zuerst Network-Interception auswerten (download/?attachment_id= / image_NNN_)
        applyInterceptedImages(parsed.messages);

        // 6c. Lazy-Load abwarten: Bild-Element in Viewport scrollen → Intersection Observer triggern
        const hasUnresolvedImages = () => (parsed.messages || []).some(m => m.isImage && !m.imageUrl);
        if (hasUnresolvedImages()) {
          // Bild-Element in den Viewport scrollen (Intersection Observer feuert nur bei sichtbaren Elementen)
          const scrollRes = await send('Runtime.evaluate', {
            expression: `(function(){
              var picEl = document.querySelector('[slot="media"], .cm-message-attachment, .protected.picture-ui, [class*="picture-ui"]');
              if (picEl) { picEl.scrollIntoView({ block: 'center', behavior: 'instant' }); return 'scrolled'; }
              var lastMsg = document.querySelector('[data-message-id]:last-child');
              if (lastMsg) { lastMsg.scrollIntoView({ block: 'end' }); return 'scrolled-last'; }
              return 'no-element';
            })()`,
            returnByValue: true
          }).catch(() => ({ result: { value: 'error' } }));
          console.log('[IMG] Scroll-Ergebnis:', scrollRes.result?.value);
          // Warten: protected picture-ui braucht Zeit zum Rendern (~2s)
          await new Promise(r => setTimeout(r, 2500));
          // Nach Scroll + Wait: Bounding-Rect holen und Screenshot nehmen
          // (protected picture-ui nutzt kein fetch/XHR → Screenshot ist einziger Weg)
          const rectsRes2 = await send('Runtime.evaluate', {
            expression: `(function(){
              var out = [];
              document.querySelectorAll('[data-message-id]').forEach(function(li) {
                var picEl = li.querySelector('.protected.picture-ui, [class*="picture-ui"], [slot="media"], .cm-message-attachment');
                if (!picEl) return;
                var r = picEl.getBoundingClientRect();
                if (r.width < 20 || r.height < 20) return;
                out.push({ lid: li.getAttribute('data-message-id'), x: r.left, y: r.top, w: r.width, h: r.height });
              });
              return JSON.stringify(out);
            })()`,
            returnByValue: true
          }).catch(() => ({ result: { value: '[]' } }));
          let ssRects = [];
          try { ssRects = JSON.parse(rectsRes2.result?.value || '[]'); } catch(e) {}
          console.log('[IMG] Screenshot-Rects nach Scroll:', JSON.stringify(ssRects));

          // Versuch 1: Canvas.toDataURL() – funktioniert wenn JOYclub 2D-Canvas nutzt
          const canvasRes = await send('Runtime.evaluate', {
            expression: `(function(){
              var results = [];
              document.querySelectorAll('[data-message-id]').forEach(function(li) {
                var picEl = li.querySelector('.protected.picture-ui, [class*="picture-ui"], [slot="media"], .cm-message-attachment');
                if (!picEl) return;
                // Canvas-Versuch
                var canvas = picEl.querySelector('canvas');
                if (canvas) {
                  try {
                    var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
                    results.push({ lid: li.getAttribute('data-message-id'), type: 'canvas', dataUrl: dataUrl });
                    return;
                  } catch(e) { results.push({ lid: li.getAttribute('data-message-id'), type: 'canvas-err', err: e.message }); }
                }
                // Blob/img currentSrc Versuch
                var img = picEl.querySelector('img');
                var src = img ? (img.currentSrc || img.src || '') : '';
                // DOM-Struktur loggen
                var tags = Array.from(picEl.querySelectorAll('*')).map(function(el){ return el.tagName + (el.getAttribute('class')||''); }).slice(0,10);
                results.push({ lid: li.getAttribute('data-message-id'), type: 'no-canvas', src: src.substring(0,80), tags: tags });
              });
              return JSON.stringify(results);
            })()`,
            returnByValue: true
          }).catch(() => ({ result: { value: '[]' } }));
          let canvasResults = [];
          try { canvasResults = JSON.parse(canvasRes.result?.value || '[]'); } catch(e) {}
          console.log('[IMG] Canvas-Check:', JSON.stringify(canvasResults.map(r => ({ lid: r.lid, type: r.type, err: r.err, src: r.src, tags: r.tags }))));

          // Nochmal prüfen: Network-Event feuert oft erst WÄHREND dem 2500ms-Wait
          // → applyInterceptedImages nachholen, bevor Screenshot-Loop läuft
          applyInterceptedImages(parsed.messages);

          let ssIdx = 0;
          for (const m of (parsed.messages || [])) {
            if (!m.isImage || m.imageUrl) continue;
            // Canvas-Daten direkt nutzen (kein Screenshot nötig)
            const canvasData = canvasResults[ssIdx];
            if (canvasData?.type === 'canvas' && canvasData.dataUrl?.startsWith('data:')) {
              m.imageUrl = canvasData.dataUrl;
              console.log('[IMG] Canvas-toDataURL OK:', Math.round(canvasData.dataUrl.length/1024) + 'KB');
              ssIdx++; continue;
            }
            // Fallback: Page.captureScreenshot
            const rect = ssRects[ssIdx++];
            if (!rect) continue;
            try {
              const ssRes = await send('Page.captureScreenshot', {
                format: 'jpeg', quality: 90,
                clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(rect.w, 900), height: Math.min(rect.h, 900), scale: 1 }
              });
              if (ssRes?.data) {
                m.imageUrl = 'data:image/jpeg;base64,' + ssRes.data;
                console.log('[IMG] Screenshot OK:', Math.round(rect.w) + 'x' + Math.round(rect.h), Math.round(ssRes.data.length/1024) + 'KB');
              }
            } catch(e) { console.log('[IMG] Screenshot Fehler:', e.message); }
          }
        }

        // 6d. In-Browser-Fetch: attachment_id-URLs direkt im Chromium-Kontext laden
        await fetchAttachmentsInBrowser(parsed.messages);

        // 7. Debug wenn leer: echte DOM-Diagnose – was ist auf der Seite?
        if (!parsed.count) {
          const dbg = await send('Runtime.evaluate', {
            expression: `(function(){
              var path = window.location.pathname;
              var content = document.querySelectorAll('.cm-message-bubble__content').length;
              var right   = document.querySelectorAll('[class*="cm-message-bubble--right"]').length;
              var left    = document.querySelectorAll('[class*="cm-message-bubble--left"]').length;
              var e2e     = document.querySelectorAll('[data-e2e$="-message"]').length;
              var listItems = document.querySelectorAll('li[data-message-id^="cm-message-"]').length;
              // Erstes gefundenes Bubble-Element analysieren
              var el = document.querySelector('.cm-message-bubble__content')
                    || document.querySelector('[class*="cm-message-bubble--right"]')
                    || document.querySelector('[data-e2e$="-message"]');
              var elInfo = null;
              if (el) {
                elInfo = {
                  tag: el.tagName,
                  cls: el.getAttribute('class') || '',
                  e2e: el.getAttribute('data-e2e') || '',
                  textContent: (el.textContent || '').substring(0,150),
                  innerText: (el.innerText || '').substring(0,150),
                  innerHTML: (el.innerHTML || '').substring(0,400),
                  hasShadow: !!el.shadowRoot,
                  shadowHtml: el.shadowRoot ? (el.shadowRoot.innerHTML||'').substring(0,400) : null,
                  childClasses: Array.from(el.children||[]).map(function(c){return c.getAttribute('class')||c.tagName;})
                };
              }
              return JSON.stringify({ path: path, content: content, right: right, left: left, e2e: e2e, listItems: listItems, el: elInfo });
            })()`,
            returnByValue: true
          });
          try { parsed.debugInfo = JSON.parse(dbg.result?.value || '{}'); } catch(e) {}
        }

        applyInterceptedImages(parsed.messages);
        await fetchAttachmentsInBrowser(parsed.messages);
        clearTimeout(timer);
        ws.close();
        resolve(parsed);
      } catch(e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// Navigiert im Chromium zu einer URL und gibt den gerenderten HTML zurück (für SPAs)
function fetchPageRenderedViaCDP(wsUrl, targetUrl, waitMs = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
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
      timer = setTimeout(() => { ws.close(); reject(new Error('CDP Render Timeout')); }, TIMEOUT);
      try {
        await send('Page.enable');
        await send('Page.navigate', { url: targetUrl });
        // Warten bis DOMContentLoaded + SPA-Hydration
        await new Promise(r => setTimeout(r, waitMs));
        const urlResult  = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
        const htmlResult = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
        clearTimeout(timer);
        ws.close();
        resolve({
          html:     htmlResult.result?.value || '',
          finalUrl: urlResult.result?.value  || targetUrl,
        });
      } catch(err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
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

        // Viewport auf 1920×1400 setzen → alle Elemente sicher im Viewport (kein Scroll nötig)
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1920, height: 1400, deviceScaleFactor: 1, mobile: false
        });

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
                'input[type="text"]:not([type="password"]), input[type="email"], .v-field__input[type="text"]'
              );
              if (!el) throw new Error('Username-Feld nicht gefunden');
              el.focus();
              // Vue 3: nativer Setter damit das reactive Model aktualisiert wird
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(el, ${JSON.stringify(username)});
              el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
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
              const el = document.querySelector('input[type="password"], .v-field__input[type="password"]');
              if (!el) throw new Error('Password-Feld nicht gefunden');
              el.focus();
              // Vue 3: nativer Setter damit das reactive Model aktualisiert wird
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(el, ${JSON.stringify(password)});
              el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('blur', { bubbles: true }));
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

        // Turnstile: identity.joyclub.com hat immer Turnstile (Cross-Origin-Iframe)
        const hasTurnstile = loginPageUrl.includes('identity.joyclub') ||
          (await send('Runtime.evaluate', {
            expression: `!!document.querySelector('iframe[src*="cloudflare"], iframe[src*="turnstile"], [class*="cf-turnstile"]')`,
            returnByValue: true
          })).result?.value === true;
        console.log(`[login] Turnstile vorhanden: ${hasTurnstile}`);

        if (hasTurnstile) {
          // Turnstile-Widget finden:
          // 1. Host-Element im regulären DOM (data-sitekey / cf-turnstile) → getBoundingClientRect()
          // 2. Iframe-Suche als Fallback (für nicht-Shadow-DOM-Seiten)
          // 3. Fallback: relativ zum Passwort-Feld
          let pos = null;
          for (let attempt = 0; attempt < 5 && !pos; attempt++) {
            await new Promise(res => setTimeout(res, 2000));
            const posRes = await send('Runtime.evaluate', {
              expression: `
                (function() {
                  // 1. Turnstile Host-Element (liegt im normalen DOM, auch wenn Iframe im Shadow-DOM)
                  const hostSelectors = [
                    '[data-sitekey]',
                    '[class*="cf-turnstile"]',
                    'cf-turnstile',
                    '[id*="cf-chl"]',
                    '[class*="turnstile"]'
                  ];
                  for (const sel of hostSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                      const r = el.getBoundingClientRect();
                      if (r.width > 20 && r.height > 20)
                        return { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), via: 'host:' + sel };
                    }
                  }
                  // 2. Iframe (für Seiten ohne Shadow-DOM)
                  for (const f of document.querySelectorAll('iframe')) {
                    const r = f.getBoundingClientRect();
                    if (r.width > 50 && r.height > 20)
                      return { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), via: 'iframe', src: (f.src||'').substring(0,60) };
                  }
                  return null;
                })()
              `,
              returnByValue: true
            });
            const result = posRes.result?.value;
            if (result) {
              console.log(`[login] Turnstile-Suche (${attempt+1}): via=${result.via} x=${result.x} y=${result.y} w=${result.w} h=${result.h}`);
              pos = result;
            } else {
              console.log(`[login] Turnstile-Suche (${attempt+1}): nicht gefunden`);
            }
          }
          // Fallback: relativ zum Passwort-Feld
          if (!pos) {
            const fbRes = await send('Runtime.evaluate', {
              expression: `
                (function() {
                  const pw = document.querySelector('input[type="password"]');
                  if (pw) {
                    const r = pw.getBoundingClientRect();
                    return { x: Math.round(r.left), y: Math.round(r.bottom + 90), h: 65, w: 300, via: 'fallback' };
                  }
                  return { x: 50, y: 400, h: 65, w: 300, via: 'fallback-hardcoded' };
                })()
              `,
              returnByValue: true
            });
            pos = fbRes.result?.value;
            console.log(`[login] Turnstile-Fallback: ${JSON.stringify(pos)}`);
          }
          if (pos) {
            const cx = pos.x + 25;
            const cy = pos.y + Math.round(pos.h / 2);
            console.log(`[login] Turnstile klicken bei (${cx}, ${cy})`);
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx - 15, y: cy - 5, button: 'none' });
            await new Promise(res => setTimeout(res, 150));
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
            await new Promise(res => setTimeout(res, 150));
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
            await new Promise(res => setTimeout(res, 120));
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
          }
          // Warten bis Turnstile Verifikation abgeschlossen (länger für CF-Challenge)
          await new Promise(res => setTimeout(res, 12000));
        } else {
          await new Promise(res => setTimeout(res, 2000));
        }

        // Kein Scroll nötig – Viewport ist 1920×1080, alle Elemente immer sichtbar

        // Submit – Button finden und per JS + CDP-Koordinaten klicken
        const submitRes = await send('Runtime.evaluate', {
          expression: `
            (function() {
              // 1. j-button Web Component (identity.joyclub.com) – Shadow Root ist open
              const jBtn = document.querySelector('[data-e2e="button-submit"], j-button[class*="submit"], [class*="submit-btn"]');
              if (jBtn) {
                const inner = jBtn.shadowRoot?.querySelector('button') || jBtn;
                inner.click();
                const r = (jBtn.shadowRoot?.querySelector('button') || jBtn).getBoundingClientRect();
                return { found: 'j-button', text: (inner.textContent||'Login').trim(), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
              }

              // 2. Normale Buttons
              const isVis = el => { const s = window.getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; };
              const allBtns = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(isVis);
              const info = allBtns.map(b => (b.textContent||b.value||'').trim().substring(0,20));

              const byType = allBtns.find(b => b.type === 'submit');
              if (byType) {
                byType.click();
                const r = byType.getBoundingClientRect();
                return { found: 'type=submit', text: (byType.textContent||byType.value).trim(), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
              }

              const byText = allBtns.find(b => /^(login|anmelden|einloggen)$/i.test((b.textContent||b.value||'').trim()));
              if (byText) {
                byText.click();
                const r = byText.getBoundingClientRect();
                return { found: 'text', text: (byText.textContent||byText.value).trim(), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
              }

              const noLang = allBtns.filter(b => !/^(deutsch|english|français|italiano|español|nederlands|čeština|português)$/i.test((b.textContent||'').trim()));
              const last = noLang[noLang.length - 1];
              if (last) {
                last.click();
                const r = last.getBoundingClientRect();
                return { found: 'last', text: (last.textContent||last.value).trim(), x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
              }

              return { found: 'none', text: '', info };
            })()
          `,
          returnByValue: true
        });
        const submitData = submitRes.result?.value || {};
        console.log(`[login] Submit: ${submitData.found} "${submitData.text}" ${submitData.x ? 'at (' + submitData.x + ',' + submitData.y + ')' : (JSON.stringify(submitData.info||[]))}`);

        // Zusätzlich per CDP-Mausklick (zuverlässiger als .click() bei position:fixed)
        if (submitData.x && submitData.y) {
          await new Promise(res => setTimeout(res, 200));
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: submitData.x, y: submitData.y, button: 'left', clickCount: 1 });
          await new Promise(res => setTimeout(res, 100));
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: submitData.x, y: submitData.y, button: 'left', clickCount: 1 });
        }

        // Warten auf Redirect nach Login
        await new Promise(res => setTimeout(res, 10000));

        const urlRes = await send('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true
        });
        const currentUrl = urlRes.result?.value || '';
        const loggedIn = !currentUrl.includes('/login') && !currentUrl.includes('cfidentity') && !currentUrl.includes('identity.joyclub');

        // Viewport-Override zurücksetzen
        await send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});

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

// ── Background Cookie Sync ────────────────────────────────────────────────────
// Erkennt Login-Zustandsänderung in Chromium und synct Cookies automatisch zu NocoDB
// → Funktioniert sowohl nach manuellem Login als auch nach Auto-Login

let bgLastLoginState   = false;
let bgLastSyncTime     = 0;
let bgAutoLoginPending = false;
let bgLastAutoLoginAt  = 0;
let latestCookieStr    = ''; // Immer frischer Cookie-String aus Chromium (für proxy-image)

async function backgroundCookieSync() {
  try {
    const wsUrl = await getCDPTarget();
    const [allCookies, currentUrl] = await Promise.all([
      getAllCookiesViaCDP(wsUrl),
      getPageUrlViaCDP(wsUrl).catch(() => '')
    ]);
    const now = Date.now() / 1000;
    const valid = allCookies.filter(c =>
      c.domain && c.domain.toLowerCase().includes(FILTER_DOMAIN) && c.expires > now
    );
    // Immer in Memory cachen (für proxy-image, unabhängig von NocoDB-Sync-Intervall)
    if (valid.length > 0) latestCookieStr = valid.map(c => `${c.name}=${c.value}`).join('; ');
    // Wenn Chromium auf Login-Seite → ausgeloggt, auch wenn noch Cookies vorhanden
    const onLoginPage = /identity\.joyclub|logged_out|\/login/i.test(currentUrl);
    const isLoggedIn = valid.length > 0 && !onLoginPage;

    const justLoggedIn  = isLoggedIn && !bgLastLoginState;
    const justLoggedOut = !isLoggedIn && bgLastLoginState;
    const periodicSync  = isLoggedIn && (Date.now() - bgLastSyncTime) > 30 * 60 * 1000;

    if (justLoggedOut) {
      // Logout erkannt → DB als abgelaufen markieren (gestern)
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
      const { list } = await db.getCookies();
      const rowId = list?.[0]?.Id || 1;
      await db.updateCookies(rowId, { Cookie: '', Ablaufdatum: yesterday });
      console.log(`[bg-sync] Logout erkannt → DB als abgelaufen markiert (${yesterday})`);
    }

    // ── Auto-Login: Cookies abgelaufen + Credentials vorhanden → automatisch neu einloggen
    const cooldownOk = (Date.now() - bgLastAutoLoginAt) > 90 * 60 * 1000; // max 1x pro 90 Min
    if (!isLoggedIn && storedCredentials?.username && !bgAutoLoginPending && cooldownOk) {
      bgAutoLoginPending = true;
      bgLastAutoLoginAt  = Date.now();
      console.log(`[bg-sync] Cookies abgelaufen → Auto-Login startet (${storedCredentials.username})`);
      getCDPTarget()
        .then(ws2 => loginViaCDP(ws2, storedCredentials.username, storedCredentials.password, true))
        .then(r  => { console.log(`[bg-sync] Auto-Login: ${r.success ? 'Erfolg' : 'Fehlgeschlagen'} (${r.url})`); bgAutoLoginPending = false; })
        .catch(e => { console.log(`[bg-sync] Auto-Login Fehler: ${e.message}`); bgAutoLoginPending = false; });
    }

    if (justLoggedIn || periodicSync) {
      const cookieString = valid.map(c => `${c.name}=${c.value}`).join('; ');
      const maxExpiry    = valid.reduce((max, c) => c.expires > 0 ? Math.max(max, c.expires) : max, 0);
      const ablaufdatum  = maxExpiry > 0 ? new Date(maxExpiry * 1000).toISOString().split('T')[0] : null;
      const { list } = await db.getCookies();
      const rowId = list?.[0]?.Id || 1;
      await db.updateCookies(rowId, { Cookie: cookieString, Ablaufdatum: ablaufdatum });
      bgLastSyncTime = Date.now();
      console.log(`[bg-sync] Cookies synced: ${valid.length} Cookies, gültig bis ${ablaufdatum} (${justLoggedIn ? 'Login erkannt' : 'periodisch'})`);
    }
    bgLastLoginState = isLoggedIn;
  } catch(e) {
    // Chromium nicht erreichbar → still ignorieren
  }
}

// Start nach 30s (Chromium braucht Anlaufzeit), dann alle 60s
setTimeout(() => { backgroundCookieSync(); setInterval(backgroundCookieSync, 60_000); }, 30_000);

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

  // GET /session-check  →  Schnelle Prüfung ob Chromium noch eingeloggt ist (kein Navigate)
  if (url.pathname === '/session-check') {
    try {
      const wsUrl = await getCDPTarget();
      const [cookies, currentUrl] = await Promise.all([
        getAllCookiesViaCDP(wsUrl),
        getPageUrlViaCDP(wsUrl).catch(() => '')
      ]);
      const now = Date.now() / 1000;
      const valid = cookies.filter(c =>
        c.domain && c.domain.toLowerCase().includes(FILTER_DOMAIN) && c.expires > now
      );
      // Wenn Chromium aktuell auf Login/Logout-Seite → definitiv ausgeloggt
      const onLoginPage = /identity\.joyclub|logged_out|\/login/i.test(currentUrl);
      const loggedIn = onLoginPage ? false : valid.length > 0;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ loggedIn, count: valid.length, url: currentUrl }));
    } catch(err) {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ loggedIn: null, error: err.message }));
    }
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

      // DB aktualisieren (kein n8n-Umweg nötig)
      try {
        const { list } = db.getCookies();
        const rowId = list?.[0]?.Id || 1;
        db.updateCookies(rowId, { Cookie: cookieString, Ablaufdatum: ablaufdatum });
      } catch (_) {}

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
        if (result.success) persistCredentials({ username, password });
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

  // GET /notifications → JOYclub Benachrichtigungen via Cookie-HTTP-Fetch
  if (url.pathname === '/notifications' && req.method === 'GET') {
    try {
      const wsUrl = await getCDPTarget();
      const cookies = await getAllCookiesViaCDP(wsUrl);
      const now = Date.now() / 1000;
      const jcCookies = cookies.filter(c =>
        c.domain && c.domain.toLowerCase().includes('joyclub') &&
        (c.expires === -1 || c.expires > now)
      );
      const cookieHeader = jcCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const { html, finalUrl } = await fetchPageWithCookies('https://www.joyclub.de/benachrichtigung/', cookieHeader);
      const result = parseJoyclubNotifications(html, finalUrl);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, totalCount: 0, items: [] }));
    }
    return;
  }

  // POST /notifications/mark-read → alle JOYclub Benachrichtigungen als gelesen markieren
  if (url.pathname === '/notifications/mark-read' && req.method === 'POST') {
    try {
      const wsUrl = await getCDPTarget();
      const cookies = await getAllCookiesViaCDP(wsUrl);
      const now = Date.now() / 1000;
      const jcCookies = cookies.filter(c =>
        c.domain && c.domain.toLowerCase().includes('joyclub') &&
        (c.expires === -1 || c.expires > now)
      );
      const cookieHeader = jcCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const result = await markJoyclubNotificationsRead(cookieHeader);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // GET /messages/debug → roher HTML für Diagnose
  if (url.pathname === '/messages/debug' && req.method === 'GET') {
    try {
      const wsUrl = await getCDPTarget();
      const { html, finalUrl } = await fetchPageRenderedViaCDP(wsUrl, 'https://www.joyclub.de/clubmail/', 5000);
      // Links auf /clubmail/ extrahieren als quick-check
      const nameHits = (html.match(/conversation-list-item-name/g)||[]).length;
      // Kompletten Block eines Eintrags zeigen: von 2000 vor dem ersten Name bis 2000 danach
      const firstHit = html.indexOf('conversation-list-item-name');
      const bigCtx = firstHit >= 0 ? html.substring(Math.max(0,firstHit-2000), firstHit+2000) : 'NOT FOUND';
      // Wie oft kommt conversation-list-item-name vor dem ersten __text vor?
      const textHit = html.indexOf('cm-conversation-list-item__text');
      const distNameToText = textHit - firstHit;
      const hrefHit = html.indexOf('href="/clubmail/');
      const distNameToHref = hrefHit - firstHit;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ finalUrl, htmlLength: html.length, nameHits, distNameToText, distNameToHref, bigCtx: bigCtx.substring(0,4000) }));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/generate-draft → Thread laden + n8n Webhook → Draft synchron zurückgeben
  if (url.pathname === '/api/generate-draft' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name, url: convUrl, messages: clientMessages } = JSON.parse(body || '{}');
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'name fehlt' }));
          return;
        }
        // Wenn Frontend bereits Nachrichten mitschickt → kein zweiter CDP-Fetch nötig
        let messages = (Array.isArray(clientMessages) && clientMessages.length > 0) ? clientMessages : null;
        if (!messages) {
          const wsUrl = await getCDPTarget();
          const threadData = await fetchClubMailThreadViaCDP(wsUrl, name, name, convUrl);
          messages = threadData.messages || [];
        }
        if (!messages.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Keine Nachrichten im Thread' }));
          return;
        }
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.own) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Letzte Nachricht ist bereits von Tobi' }));
          return;
        }
        const _senderName = messagesListCache?.senderName || 'Tobi';
        const recent = messages.slice(-20);
        const history = recent.map(m => {
          const who = m.own ? _senderName + ' (ich)' : name;
          const txt = m.isImage ? '[Foto]' : (m.text || '');
          return `${who}: ${txt.substring(0, 300)}`;
        }).join('\n');

        // wartelisteStatus: auf welchen Events ist Person bereits angemeldet?
        const _wlMsg = messages.find(m => m.own && /warteliste/i.test(m.text || ''));
        const _wlIdx = _wlMsg ? messages.lastIndexOf(_wlMsg) : -1;
        const _wlRecent = _wlIdx >= 0 && _wlIdx >= messages.length - 4;
        const _wlEvents = messages
          .filter(m => m.own && /warteliste/i.test(m.text || ''))
          .map(m => { const ma = (m.text || '').match(/für\s+(.+?)\s+am\s+/i); return ma ? ma[1].trim() : null; })
          .filter(Boolean);
        const wartelisteStatus = _wlEvents.length ? 'BEREITS AUF WARTELISTE: ' + _wlEvents.join(', ') : '';

        // contextHint: spezifische Anweisung für Foto-nach-Warteliste
        let contextHint = '';
        if (_wlRecent && lastMsg.isImage) {
          contextHint = 'FOTO_EINGEGANGEN: Person hat gerade ein Foto für das Voting geschickt. Kurze freundliche Dankesantwort + bestätige dass sie für das nächste Donnerstags-Voting berücksichtigt werden.';
        }

        // isFirstMessage: keine eigene Nachricht bisher in diesem Thread?
        const isFirstMessage = !messages.some(m => m.own);
        // Wer schreibt? (aus /messages Cache)
        const PROFILE_NAMES = { '9612457': 'Tobi', '9587483': 'Kristina' };
        const senderName = messagesListCache?.senderName || 'Tobi';

        // n8n-Escaping: {{ }} im Text nicht an n8n-Template-Parser weitergeben
        const esc = s => (s || '').replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
        const safeHistory = esc(history);
        const safeLastMsg = esc(lastMsg.isImage ? '[Foto]' : (lastMsg.text || ''));

        // Vollständigen Prompt-Text bereits hier bauen (vermeidet n8n-Template-Syntax-Fehler)
        const promptParts = [
          'Absender: ' + name,
          '',
          wartelisteStatus ? 'WICHTIGER KONTEXT - ' + wartelisteStatus : '',
          contextHint ? 'HINWEIS: ' + contextHint : '',
          '',
          'Gesprächsverlauf (neueste Nachricht zuletzt):',
          safeHistory,
          '',
          'Letzte Nachricht:',
          safeLastMsg,
          '',
          'Gib NUR den fertigen Antworttext aus. Kein Betreff, keine Erklärung.',
        ];
        const promptText = promptParts.filter(l => l !== '').join('\n');

        // n8n Webhook aufrufen (synchron via Respond-to-Webhook)
        const postBody = JSON.stringify({ name, lastMessage: safeLastMsg, history: safeHistory, gender: null, wartelisteStatus, contextHint, isFirstMessage, senderName, promptText });
        const n8nResp = await new Promise((resolve, reject) => {
          const https = require('https');
          const rq = https.request({
            hostname: 'n8n.f3-events.de',
            path: '/webhook/generate-draft',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
          }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
          });
          rq.setTimeout(60000, () => { rq.destroy(); reject(new Error('n8n Webhook Timeout')); });
          rq.on('error', reject);
          rq.write(postBody);
          rq.end();
        });
        if (n8nResp.draft) {
          messageDrafts.set(name, { draft: n8nResp.draft, createdAt: new Date().toISOString() });
        }
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, draft: n8nResp.draft || '' }));
      } catch(err) {
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/message-drafts → KI-Entwurf speichern { name, draft }
  if (url.pathname === '/api/message-drafts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, draft } = JSON.parse(body || '{}');
        if (!name || !draft) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'name und draft erforderlich' }));
          return;
        }
        messageDrafts.set(name, { draft, createdAt: new Date().toISOString() });
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // DELETE /api/message-drafts/:name → Entwurf löschen (nach dem Senden)
  if (url.pathname.match(/^\/api\/message-drafts\/[^/]+$/) && req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.split('/')[3]);
    messageDrafts.delete(name);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /messages → JOYclub ClubMail-Liste
  // Stale-while-revalidate: Cache immer sofort zurück, CDP nur wenn nötig
  if (url.pathname === '/messages' && req.method === 'GET') {
    const cacheAge = Date.now() - messagesListCachedAt;
    const cacheFresh = messagesListCache && !messagesListDirty && cacheAge < MESSAGES_LIST_CACHE_TTL;
    const cacheStale = messagesListCache && !messagesListDirty && cacheAge >= MESSAGES_LIST_CACHE_TTL;

    // ① Cache frisch + nicht dirty → sofort zurück, kein CDP
    if (cacheFresh) {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messagesListCache));
      return;
    }

    // ② Cache vorhanden aber stale (nicht dirty) → sofort stale zurück + Background-Refresh
    if (cacheStale) {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...messagesListCache, stale: true }));
      // Hintergrund-Refresh ohne await – User wartet nicht
      withCDPLock(async () => {
        const wsUrl = await getCDPTarget();
        return fetchClubMailViaCDP(wsUrl);
      }, 75000).then(result => {
        messagesListCache = result;
        messagesListCachedAt = Date.now();
        messagesListDirty = false;
      }).catch(() => {});
      return;
    }

    // ③ Cache leer oder dirty → synchroner Full-Fetch (User wartet einmalig)
    try {
      const result = await withCDPLock(async () => {
        const wsUrl = await getCDPTarget();
        return fetchClubMailViaCDP(wsUrl);
      }, 75000);
      messagesListCache = result;
      messagesListCachedAt = Date.now();
      messagesListDirty = false;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      if (messagesListCache) {
        res.end(JSON.stringify({ ...messagesListCache, stale: true }));
      } else {
        res.end(JSON.stringify({ error: err.message, totalCount: 0, items: [] }));
      }
    }
    return;
  }

  // POST /messages/refresh → Cache als dirty markieren (z.B. nach dem Senden)
  if (url.pathname === '/messages/refresh' && req.method === 'POST') {
    messagesListDirty = true;
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /messages/:id → Einzelne Konversation lesen (id = convId oder Name, ?name= optional)
  // Cache-first: frische Daten (< 3 min) sofort zurück; stale → CDP laden und cachen
  if (url.pathname.match(/^\/messages\/[^/]+$/) && req.method === 'GET') {
    const msgId   = decodeURIComponent(url.pathname.split('/')[2]);
    const msgName = url.searchParams.get('name') ? decodeURIComponent(url.searchParams.get('name')) : msgId;
    const msgUrl  = url.searchParams.get('url') ? decodeURIComponent(url.searchParams.get('url')) : null;
    const CACHE_FRESH_MS = 3 * 60 * 1000; // 3 Minuten
    const cached = threadCache.get(msgName);
    const cacheAge = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
    const cachedDraft = messageDrafts.get(msgName)?.draft || null;

    if (cached && cacheAge < CACHE_FRESH_MS) {
      // Cache-Hit: sofort antworten
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msgId, name: msgName, messages: cached.messages, draft: cachedDraft, fromCache: true, cachedAt: cached.fetchedAt }));
      // Im Hintergrund refreshen wenn > 90s alt
      if (cacheAge > 90 * 1000) {
        withCDPLock(async () => {
          const ws = await getCDPTarget();
          return fetchClubMailThreadViaCDP(ws, msgId, msgName, msgUrl || cached.url);
        }).then(data => {
          if (data.messages?.length) threadCache.set(msgName, { messages: data.messages, fetchedAt: new Date().toISOString(), id: msgId, url: msgUrl || cached.url });
        }).catch(() => {});
      }
      return;
    }

    // Cache-Miss oder abgelaufen: CDP laden (mit Mutex → serialisiert)
    try {
      const data = await withCDPLock(async () => {
        const wsUrl = await getCDPTarget();
        return fetchClubMailThreadViaCDP(wsUrl, msgId, msgName, msgUrl);
      });
      if (data.messages?.length) {
        threadCache.set(msgName, { messages: data.messages, fetchedAt: new Date().toISOString(), id: msgId, url: msgUrl });
      }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msgId, name: msgName, messages: data.messages || [], draft: cachedDraft }));
    } catch(err) {
      // Fehler: falls Cache vorhanden (auch wenn alt) → lieber altes zurück als leer
      if (cached) {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msgId, name: msgName, messages: cached.messages, draft: cachedDraft, fromCache: true, stale: true }));
      } else {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, error: err.message, messages: [] }));
      }
    }
    return;
  }

  // POST /messages/mark-read → Konversation als gelesen markieren (CDP Navigation)
  // Body: { convId, convUrl }  – aufgerufen von WF5 für Komplimente + Dashboard
  if (url.pathname === '/messages/mark-read' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { convId, convUrl } = JSON.parse(body || '{}');
        if (!convUrl && !convId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'convUrl oder convId erforderlich' }));
          return;
        }
        const wsUrl = await getCDPTarget();
        const ws2 = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
        await new Promise((resolve, reject) => {
          let _mid2 = 0;
          const pending2 = {};
          const s2 = (m, p = {}) => {
            const id = ++_mid2;
            return new Promise((r, rj) => { pending2[id] = { r, rj }; ws2.send(JSON.stringify({ id, method: m, params: p })); });
          };
          ws2.on('message', raw => {
            try { const msg = JSON.parse(raw); if (msg.id && pending2[msg.id]) { const { r, rj } = pending2[msg.id]; delete pending2[msg.id]; msg.error ? rj(new Error(msg.error.message)) : r(msg.result); } } catch(e) {}
          });
          ws2.on('error', reject);
          ws2.on('open', async () => {
            const timer = setTimeout(() => { ws2.close(); resolve(); }, 18000);
            try {
              const target = convUrl || ('https://www.joyclub.de/clubmail/' + convId + '/');
              await s2('Page.navigate', { url: target });
              // 3 Sekunden warten damit die Seite lädt und die Nachricht als gelesen gilt
              await new Promise(r => setTimeout(r, 3000));
              ws2.close();
            } catch(e) { /* ignore */ } finally { clearTimeout(timer); resolve(); }
          });
        });
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(err) {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/transcribe → Audio-Blob transkribieren via OpenAI Whisper
  // Body: { audio: '<base64>', mimeType: 'audio/webm' }
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { audio, mimeType = 'audio/webm' } = JSON.parse(body || '{}');
        if (!audio) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'audio (base64) fehlt' }));
          return;
        }
        const OPENAI_KEY = process.env.OPENAI_API_KEY;
        if (!OPENAI_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'OPENAI_API_KEY nicht konfiguriert' }));
          return;
        }
        // Audio-Bytes dekodieren + als multipart/form-data an OpenAI senden
        const audioBuffer = Buffer.from(audio, 'base64');
        const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
        const boundary = '----F3Boundary' + Date.now();
        const CRLF = '\r\n';
        // Multipart-Body aufbauen
        const partHeader = Buffer.from(
          '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="file"; filename="audio.' + ext + '"' + CRLF +
          'Content-Type: ' + mimeType + CRLF + CRLF
        );
        const modelPart = Buffer.from(
          CRLF + '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="model"' + CRLF + CRLF +
          'whisper-1' +
          CRLF + '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="language"' + CRLF + CRLF +
          'de' +
          CRLF + '--' + boundary + '--' + CRLF
        );
        const multipartBody = Buffer.concat([partHeader, audioBuffer, modelPart]);
        const transcript = await new Promise((resolve, reject) => {
          const https2 = require('https');
          const rq = https2.request({
            hostname: 'api.openai.com',
            path: '/v1/audio/transcriptions',
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + OPENAI_KEY,
              'Content-Type': 'multipart/form-data; boundary=' + boundary,
              'Content-Length': multipartBody.length,
            },
          }, r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => { try { const j = JSON.parse(d); resolve(j.text || ''); } catch(e) { reject(new Error('Whisper parse error: ' + d.substring(0,200))); } });
          });
          rq.setTimeout(30000, () => { rq.destroy(); reject(new Error('Whisper Timeout')); });
          rq.on('error', reject);
          rq.write(multipartBody);
          rq.end();
        });
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: transcript }));
      } catch(err) {
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /messages/send → Nachricht senden { name, text }
  // Nutzt CDP: Chromium ist nach fetchClubMailThreadViaCDP bereits auf der Konversation
  if (url.pathname === '/messages/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name: convName, url: convUrl, text, imageBase64, imageMimeType } = JSON.parse(body || '{}');
        if (!convName || (!text && !imageBase64)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'name und text oder imageBase64 erforderlich' }));
          return;
        }

        const wsUrl = await getCDPTarget();
        const result = await new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
          let _mid = 0;
          const pending = {};
          const send2 = (method, params = {}) => {
            const id = ++_mid;
            return new Promise((res2, rej2) => {
              pending[id] = { res: res2, rej: rej2 };
              ws.send(JSON.stringify({ id, method, params }));
            });
          };
          // Event-Handler Map für CDP Push-Events (kein id, nur method+params)
          const eventHandlers = {};
          ws.on('message', raw => {
            try {
              const msg = JSON.parse(raw);
              if (msg.id && pending[msg.id]) {
                const { res: r2, rej: rj2 } = pending[msg.id];
                delete pending[msg.id];
                if (msg.error) rj2(new Error(msg.error.message));
                else r2(msg.result);
              } else if (!msg.id && msg.method && eventHandlers[msg.method]) {
                const cb = eventHandlers[msg.method];
                delete eventHandlers[msg.method];
                cb(msg.params);
              }
            } catch(e) {}
          });
          ws.on('error', reject);
          ws.on('open', async () => {
            const timer = setTimeout(() => { ws.close(); reject(new Error('Send CDP Timeout')); }, 55000);
            try {
              await send2('Page.enable');

              // Direkt zur Konversations-URL navigieren
              // convUrlCache (Server-seitig) als Fallback wenn Client keine ID hat
              let effectiveUrl = (convUrl && /joyclub\.de\/clubmail\/\d+/.test(convUrl)) ? convUrl : null;
              if (!effectiveUrl && convUrlCache.has(convName)) {
                effectiveUrl = 'https://www.joyclub.de' + convUrlCache.get(convName);
              }
              // Auch convId direkt probieren (numerisch → /clubmail/conversation/)
              if (!effectiveUrl && /^\d+$/.test(String(convName))) {
                effectiveUrl = `https://www.joyclub.de/clubmail/conversation/${convName}`;
              }
              console.log('[Send] convName:', convName, '| url:', effectiveUrl || '(kein URL → Liste)');
              const targetUrl = effectiveUrl;
              if (targetUrl) {
                // Direkt-Navigation – kein List-Scraping nötig
                const curPathR = await send2('Runtime.evaluate', { expression: `window.location.href`, returnByValue: true });
                const curHref  = curPathR.result?.value || '';
                if (!curHref.includes(targetUrl.replace('https://www.joyclub.de', ''))) {
                  try { await send2('Page.stopLoading'); } catch(e) {}
                  await send2('Page.navigate', { url: targetUrl });
                }
                // Warten bis Textarea erscheint (max 12s)
                for (let i = 0; i < 24; i++) {
                  await new Promise(r => setTimeout(r, 500));
                  const chk = await send2('Runtime.evaluate', {
                    expression: `!!(document.querySelector('#joy-input-wonder-textarea') || document.querySelector('[data-e2e="input-wonder"] textarea'))`,
                    returnByValue: true
                  });
                  if (chk.result?.value) break;
                }
              } else {
                // Fallback: Liste navigieren + Eintrag anklicken
                const curPathR = await send2('Runtime.evaluate', { expression: `window.location.pathname`, returnByValue: true });
                const curPath2 = curPathR.result?.value || '';
                if (!curPath2.includes('/clubmail/conversation/')) {
                  try { await send2('Page.stopLoading'); } catch(e) {}
                  await send2('Page.navigate', { url: 'https://www.joyclub.de/clubmail/' });
                  for (let i = 0; i < 20; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    const chk = await send2('Runtime.evaluate', { expression: `document.querySelectorAll('[data-e2e="conversation-list-entry"]').length`, returnByValue: true });
                    if ((chk.result?.value || 0) > 0) break;
                  }
                  await send2('Runtime.evaluate', {
                    expression: `(function(){
                      for (const e of document.querySelectorAll('[data-e2e="conversation-list-entry"]')) {
                        if (e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim() === ${JSON.stringify(convName)})
                          { e.scrollIntoView({ block: 'center' }); return; }
                      }
                    })()`, returnByValue: true
                  });
                  await new Promise(r => setTimeout(r, 300));
                  const posR = await send2('Runtime.evaluate', {
                    expression: `(function(){
                      for (const e of document.querySelectorAll('[data-e2e="conversation-list-entry"]')) {
                        if (e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim() === ${JSON.stringify(convName)}) {
                          const r = e.getBoundingClientRect();
                          return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
                        }
                      }
                      return JSON.stringify({ x: 150, y: 200 });
                    })()`, returnByValue: true
                  });
                  const pos2 = JSON.parse(posR.result?.value || '{"x":150,"y":200}');
                  await send2('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
                  await send2('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos2.x, y: pos2.y, button: 'left', clickCount: 1 });
                  for (let i = 0; i < 14; i++) {
                    await new Promise(r => setTimeout(r, 500));
                    const p = await send2('Runtime.evaluate', { expression: `window.location.pathname`, returnByValue: true });
                    if ((p.result?.value || '').includes('/conversation/')) break;
                  }
                  await new Promise(r => setTimeout(r, 1500));
                }
              }

              // ── Bild-Upload (optional) ──────────────────────────────────────
              if (imageBase64) {
                const os = require('os');
                const path = require('path');
                const imgBuf = Buffer.from(imageBase64, 'base64');
                const tmpPath = path.join(os.tmpdir(), 'f3_upload_' + Date.now() + '.jpg');
                require('fs').writeFileSync(tmpPath, imgBuf);
                let imgUploaded = false;
                try {
                  // Strategie A: Page.setInterceptFileChooserDialog
                  // CDP interceptet den Datei-Dialog wenn wir den Foto-Button klicken
                  try {
                    await send2('Page.setInterceptFileChooserDialog', { enabled: true });
                    const fileChooserOpened = new Promise(resolve => {
                      eventHandlers['Page.fileChooserOpened'] = resolve;
                    });
                    // Foto-Button finden und klicken
                    const btnClickRes = await send2('Runtime.evaluate', {
                      expression: `(function(){
                        // Priorität 1: data-e2e
                        var btn = document.querySelector('[data-e2e="attach-image-button"],[data-e2e*="foto"],[data-e2e*="image-attach"],[data-e2e*="attachment-button"]');
                        // Priorität 2: aria-label / title
                        if (!btn) {
                          var cands = document.querySelectorAll('button,[role="button"]');
                          for (var i = 0; i < cands.length; i++) {
                            var l = (cands[i].getAttribute('aria-label')||'') + (cands[i].getAttribute('title')||'');
                            if (/foto|bild|image|attach/i.test(l)) { btn = cands[i]; break; }
                          }
                        }
                        // Priorität 3: text "Foto"
                        if (!btn) {
                          var all = document.querySelectorAll('button,[role="button"]');
                          for (var j = 0; j < all.length; j++) {
                            if (/^foto$/i.test((all[j].textContent||'').trim())) { btn = all[j]; break; }
                          }
                        }
                        // Priorität 4: input[type=file] direkt klicken
                        if (!btn) {
                          var inp = document.querySelector('input[type="file"]');
                          if (inp) { inp.click(); return 'input-click'; }
                        }
                        if (btn) { btn.click(); return 'btn:' + (btn.getAttribute('data-e2e')||btn.textContent.trim().substring(0,20)); }
                        return 'not-found';
                      })()`,
                      returnByValue: true
                    });
                    console.log('[Send] Foto-Button:', btnClickRes.result?.value);
                    // Warte bis FileChooser geöffnet wird (max 4s)
                    const chooserEvt = await Promise.race([
                      fileChooserOpened,
                      new Promise(r => setTimeout(() => r(null), 4000))
                    ]);
                    if (chooserEvt) {
                      await send2('Page.handleFileChooser', { action: 'accept', files: [tmpPath] });
                      console.log('[Send] FileChooser handled:', tmpPath);
                      imgUploaded = true;
                    } else {
                      console.log('[Send] FileChooser timeout – versuche DOM-Fallback');
                      delete eventHandlers['Page.fileChooserOpened'];
                    }
                    await send2('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
                  } catch(e) {
                    console.log('[Send] FileChooser-Strategie fehlgeschlagen:', e.message);
                  }

                  // Strategie B (Fallback): Runtime.evaluate findet Input im Shadow DOM,
                  // DOM.requestNode gibt nodeId → DOM.setFileInputFiles
                  if (!imgUploaded) {
                    try {
                      await send2('DOM.enable');
                      const findRes = await send2('Runtime.evaluate', {
                        expression: `(function(){
                          var inp = document.querySelector('input[type="file"]');
                          if (inp) return inp;
                          function search(root) {
                            var r = root.querySelector('input[type="file"]');
                            if (r) return r;
                            var els = root.querySelectorAll('*');
                            for (var i = 0; i < els.length; i++) {
                              if (els[i].shadowRoot) { var f = search(els[i].shadowRoot); if (f) return f; }
                            }
                            return null;
                          }
                          var all = document.querySelectorAll('*');
                          for (var i = 0; i < all.length; i++) {
                            if (all[i].shadowRoot) { var f = search(all[i].shadowRoot); if (f) return f; }
                          }
                          return null;
                        })()`,
                        returnByValue: false
                      });
                      const objectId = findRes.result?.objectId;
                      if (objectId) {
                        const nodeReq = await send2('DOM.requestNode', { objectId });
                        const nodeId = nodeReq?.nodeId || 0;
                        if (nodeId > 0) {
                          await send2('DOM.setFileInputFiles', { nodeId, files: [tmpPath] });
                          console.log('[Send] DOM.setFileInputFiles via Shadow-DOM, nodeId:', nodeId);
                          imgUploaded = true;
                        }
                      }
                      if (!imgUploaded) console.log('[Send] Kein file-input gefunden');
                    } catch(e) {
                      console.log('[Send] DOM-Fallback fehlgeschlagen:', e.message);
                    }
                  }

                  // Warte auf Bild-Vorschau in JOYclubs Compose-UI (max 8s)
                  if (imgUploaded) {
                    for (let i = 0; i < 16; i++) {
                      await new Promise(r => setTimeout(r, 500));
                      const chk = await send2('Runtime.evaluate', {
                        expression: `!!(document.querySelector('[data-e2e="message-attachment-image"],[data-e2e*="attachment-preview"],ul.joy-input-wonder-image-preview-list li,[class*="preview"] img'))`,
                        returnByValue: true
                      });
                      if (chk.result?.value) { console.log('[Send] Bild-Vorschau erschienen'); break; }
                    }
                    await new Promise(r => setTimeout(r, 400));
                  }
                } finally {
                  try { require('fs').unlinkSync(tmpPath); } catch(e) {}
                }
              }

              // Textarea finden und Text eingeben (optional, wenn Text vorhanden)
              let typeStatus = 'skipped';
              if (text) {
                const typeRes = await send2('Runtime.evaluate', {
                  expression: `(function(){
                    const ta = document.querySelector('#joy-input-wonder-textarea') ||
                               document.querySelector('[data-e2e="input-wonder"] textarea') ||
                               document.querySelector('textarea[id*="joy-input"]') ||
                               document.querySelector('textarea');
                    if (!ta) return 'no-textarea';
                    ta.focus();
                    // Wert setzen via Vue reactivity
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                    nativeInputValueSetter.call(ta, ${JSON.stringify(text)});
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                    return 'typed:' + ta.value.length;
                  })()`,
                  returnByValue: true
                });
                typeStatus = typeRes.result?.value || '';
                if (typeStatus === 'no-textarea') throw new Error('Textarea nicht gefunden');
              }

              await new Promise(r => setTimeout(r, 500));

              // Sende-Button klicken
              const btnRes = await send2('Runtime.evaluate', {
                expression: `(function(){
                  const btn = document.querySelector('[data-e2e="button-submit"]') ||
                              document.querySelector('button[aria-label="Senden"]') ||
                              document.querySelector('button.joy-input-wonder__button') ||
                              [...document.querySelectorAll('button')].find(b =>
                                /senden/i.test(b.getAttribute('aria-label')||'')
                              );
                  if (btn) { btn.click(); return 'sent:' + btn.getAttribute('data-e2e'); }
                  return 'no-button';
                })()`,
                returnByValue: true
              });
              const btnStatus = btnRes.result?.value || '';
              console.log('[Send] typeStatus:', typeStatus, '| btnStatus:', btnStatus);

              clearTimeout(timer);
              ws.close();
              const ok = btnStatus.startsWith('sent');
              resolve({ ok, typeStatus, btnStatus, error: ok ? undefined : `btn:${btnStatus} type:${typeStatus}` });
            } catch(e) {
              clearTimeout(timer);
              ws.close();
              reject(e);
            }
          });
        });


        // Nach erfolgreichem Senden: Cache dirty → nächster /messages-Aufruf lädt frisch
        if (result.ok) messagesListDirty = true;
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(err) {
        res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── /api/* – DB-Abstraktionsschicht (ersetzt direkte NocoDB-Calls) ───────────
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  function readBody(r) {
    return new Promise((resolve, reject) => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch(e) { reject(e); } });
    });
  }

  // GET /api/access-token → JOYclub Access-Token direkt aus dem Browser holen (CDP)
  // Sicherer als Cookie-Export: der Browser ist bereits eingeloggt, kein Cookie-Transfer nötig
  if (url.pathname === '/api/access-token' && req.method === 'GET') {
    try {
      const token = await withCDPLock(async () => {
        const wsUrl = await getCDPTarget();
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl, { headers: { 'Host': 'localhost' } });
          const timer = setTimeout(() => { try { ws.close(); } catch(e) {} reject(new Error('Token-Timeout')); }, 15000);
          let _mid = 0; const pending = {};
          const send = (method, params = {}) => {
            const id = ++_mid;
            return new Promise((res, rej) => { pending[id] = { res, rej }; ws.send(JSON.stringify({ id, method, params })); });
          };
          ws.on('message', raw => {
            try {
              const msg = JSON.parse(raw);
              if (msg.id && pending[msg.id]) {
                const { res, rej } = pending[msg.id]; delete pending[msg.id];
                msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
              }
            } catch(e) {}
          });
          ws.on('error', e => { clearTimeout(timer); reject(e); });
          ws.on('open', async () => {
            try {
              const r = await send('Runtime.evaluate', {
                expression: `(async function() {
                  try {
                    const res = await fetch('/webauth/access_token', {
                      credentials: 'include',
                      headers: { 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest' }
                    });
                    const data = await res.json();
                    return data?.content?.access_token || data?.access_token || null;
                  } catch(e) { return null; }
                })()`,
                returnByValue: true,
                awaitPromise: true
              });
              clearTimeout(timer);
              ws.close();
              resolve(r.result?.value || null);
            } catch(e) { clearTimeout(timer); try { ws.close(); } catch(e2) {} reject(e); }
          });
        });
      }, 20000);

      if (!token) {
        res.writeHead(401, CORS);
        res.end(JSON.stringify({ error: 'Kein Token – Session abgelaufen?' }));
      } else {
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ access_token: token }));
      }
    } catch(e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/cookies
  if (url.pathname === '/api/cookies' && req.method === 'GET') {
    try {
      const result = await db.getCookies();
      res.writeHead(200, CORS); res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // PATCH /api/cookies/:id
  if (url.pathname.startsWith('/api/cookies/') && req.method === 'PATCH') {
    const id = parseInt(url.pathname.split('/')[3]);
    try {
      const body = await readBody(req);
      await db.updateCookies(id, body);
      res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // GET /api/events
  if (url.pathname === '/api/events' && req.method === 'GET') {
    try {
      const opts = {
        status: url.searchParams.get('status') || undefined,
        limit:  parseInt(url.searchParams.get('limit') || '100'),
        offset: parseInt(url.searchParams.get('offset') || '0'),
      };
      const result = await db.getEvents(opts);
      res.writeHead(200, CORS); res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // POST /api/events
  if (url.pathname === '/api/events' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const record = await db.createEvent(body);
      res.writeHead(201, CORS); res.end(JSON.stringify(record));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // PATCH /api/events/:id  or  PUT /api/events/:id
  if (url.pathname.startsWith('/api/events/') && (req.method === 'PATCH' || req.method === 'PUT')) {
    const id = parseInt(url.pathname.split('/')[3]);
    try {
      const body = await readBody(req);
      await db.updateEvent(id, body);
      res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // DELETE /api/events/:id
  if (url.pathname.startsWith('/api/events/') && req.method === 'DELETE') {
    const id = parseInt(url.pathname.split('/')[3]);
    try {
      db.deleteEvent(id);
      res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // POST /api/sync-external-events → Externe JOYclub-Events (managed) via neuem CDP-Tab holen
  // Öffnet neuen Tab, navigiert, extrahiert, schließt Tab → Haupt-Session bleibt intakt
  if (url.pathname === '/api/sync-external-events' && req.method === 'POST') {
    try {
      const MANAGED_URL = 'https://www.joyclub.de/edit/event/managed-11665301.html';

      // Neuen Tab öffnen (Haupt-Tab bleibt unberührt)
      const { wsUrl: tabWsUrl, tabId } = await withCDPLock(() => openNewCDPTab(), 10000);

      const events = await new Promise((resolve, reject) => {
        const ws = new WebSocket(tabWsUrl, { headers: { 'Host': 'localhost' } });
        const timer = setTimeout(() => { try { ws.close(); } catch(e) {} reject(new Error('Externe Events Timeout')); }, 30000);
        let _mid = 0; const pending = {};
        const send = (method, params = {}) => {
          const id = ++_mid;
          return new Promise((res2, rej2) => { pending[id] = { res: res2, rej: rej2 }; ws.send(JSON.stringify({ id, method, params })); });
        };
        ws.on('message', raw => {
          try {
            const msg = JSON.parse(raw);
            if (msg.id && pending[msg.id]) {
              const { res: r, rej } = pending[msg.id]; delete pending[msg.id];
              msg.error ? rej(new Error(msg.error.message)) : r(msg.result);
            }
          } catch(e) {}
        });
        ws.on('error', e => { clearTimeout(timer); reject(e); });
        ws.on('open', async () => {
          try {
            // Zur Managed-Events-Seite navigieren
            await send('Page.navigate', { url: MANAGED_URL });
            // Warten bis die Event-Tabelle geladen ist (JS-rendered)
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 500));
              const chk = await send('Runtime.evaluate', {
                expression: `document.querySelector('table tr td') !== null || document.querySelector('.event_list_item, .veranstaltungen_item, [class*="event"][class*="row"]') !== null`,
                returnByValue: true
              }).catch(() => ({ result: { value: false } }));
              if (chk.result?.value) break;
            }
            // Events aus dem gerenderten DOM extrahieren
            const r = await send('Runtime.evaluate', {
              expression: `(function() {
                var events = [];
                var seen = new Set();
                // Alle Tabellenzeilen
                var rows = document.querySelectorAll('table tr');
                for (var i = 0; i < rows.length; i++) {
                  var row = rows[i];
                  var cells = row.querySelectorAll('td');
                  if (cells.length < 2) continue;
                  // Event-Link suchen
                  var a = row.querySelector('a[href*="/edit/event/"], a[href*="/kalender/"], a[href*="/veranstaltung"]');
                  if (!a) a = row.querySelector('a[href]');
                  if (!a) continue;
                  var name = (a.textContent || '').replace(/\\s+/g, ' ').trim();
                  if (!name || name.length < 3 || seen.has(name)) continue;
                  // Navigationselemente / Tabs überspringen
                  if (name.match(/^(Meine|Gruppen|Forum|Mediathek|Suche|mehr|Datum|Aufrufe|Gemerkt|Warteliste|Bestätigt|Bezahlt|Anwesend|Bearbeiten|Veranstaltung)$/i)) continue;
                  seen.add(name);
                  var href = a.getAttribute('href') || '';
                  // Öffentliche Event-URL konstruieren
                  var eventLink = '';
                  var idM = href.match(/\\/edit\\/event\\/(\\d+)/);
                  if (idM) {
                    eventLink = 'https://www.joyclub.de/kalender/veranstaltungen/' + idM[1] + '.html';
                  } else if (href.includes('/event/') || href.includes('/veranstaltung')) {
                    eventLink = href.startsWith('http') ? href : 'https://www.joyclub.de' + href;
                  }
                  // Datum aus Zellen: "Sa., 05.09.2026" oder "05.09.2026"
                  var rowText = row.textContent || '';
                  var datM = rowText.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
                  var datum = datM ? datM[1] + '.' + datM[2] + '.' + datM[3] : '';
                  // Bild
                  var img = row.querySelector('img');
                  var bild = img ? (img.src || img.getAttribute('data-src') || '') : '';
                  // Statistiken aus Zellen (Aufrufe, Gemerkt, Warteliste, Bestätigt, ...)
                  var nums = [];
                  for (var j = 0; j < cells.length; j++) {
                    var v = parseInt((cells[j].textContent || '').trim());
                    nums.push(isNaN(v) ? null : v);
                  }
                  events.push({
                    name: name,
                    datum: datum,
                    link: eventLink,
                    bild: bild,
                    aufrufe:    nums[1] || null,
                    vorgemerkt: nums[2] || null,
                    warteliste: nums[3] || null,
                    angemeldet: nums[4] || null
                  });
                }
                return JSON.stringify(events);
              })()`,
              returnByValue: true
            });
            clearTimeout(timer);
            ws.close();
            try { resolve(JSON.parse(r.result?.value || '[]')); }
            catch(e) { resolve([]); }
          } catch(e) { clearTimeout(timer); try { ws.close(); } catch(e2) {} reject(e); }
        });
      });

      // Tab schließen
      await closeCDPTab(null, tabId).catch(() => {});

      // Events in SQLite speichern (upsert per Name, da Link unsicher)
      let created = 0, updated = 0;
      const allExisting = db.getEvents({ limit: 1000 }).list;
      for (const ev of events) {
        if (!ev.name) continue;
        // Upsert: per EventLink (wenn vorhanden) oder Name
        const existing = allExisting.find(r =>
          (ev.link && r.EventLink === ev.link) ||
          r.EventName === ev.name
        );
        const updateData = {
          EventName: ev.name,
          IsExternal: 1,
          Status: 'aktiv',
          ...(ev.datum   ? { EventDatum: ev.datum }        : {}),
          ...(ev.bild    ? { EventBild: ev.bild }           : {}),
          ...(ev.aufrufe   !== null ? { Aufrufe: ev.aufrufe }     : {}),
          ...(ev.vorgemerkt !== null ? { Vorgemerkt: ev.vorgemerkt } : {}),
          ...(ev.angemeldet !== null ? { Angemeldet: ev.angemeldet } : {}),
        };
        if (existing) {
          db.updateEvent(existing.Id, updateData);
          updated++;
        } else {
          db.createEvent({ ...updateData, EventLink: ev.link || '' });
          created++;
        }
      }
      console.log(`[ext-events] Sync: ${events.length} gefunden, ${created} neu, ${updated} aktualisiert`);
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, found: events.length, created, updated, events }));
    } catch(e) {
      console.error('[ext-events] Fehler:', e.message);
      res.writeHead(500, CORS); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // GET /api/ladies-voting
  if (url.pathname === '/api/ladies-voting' && req.method === 'GET') {
    try {
      const opts = {
        status: url.searchParams.get('status') || undefined,
        limit:  parseInt(url.searchParams.get('limit') || '100'),
        offset: parseInt(url.searchParams.get('offset') || '0'),
      };
      const result = await db.getLadiesVoting(opts);
      res.writeHead(200, CORS); res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // POST /api/ladies-voting
  if (url.pathname === '/api/ladies-voting' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const record = await db.createLadiesVotingCandidate(body);
      res.writeHead(201, CORS); res.end(JSON.stringify(record));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // PATCH /api/ladies-voting/:id
  if (url.pathname.startsWith('/api/ladies-voting/') && req.method === 'PATCH') {
    const id = parseInt(url.pathname.split('/')[3]);
    try {
      const body = await readBody(req);
      await db.updateLadiesVotingCandidate(id, body);
      res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // POST /api/auto-reply-log → WF5 loggt gesendete Auto-Replies
  if (url.pathname === '/api/auto-reply-log' && req.method === 'POST') {
    try {
      const entry = await readBody(req);
      autoReplyLog.unshift({ ...entry, sentAt: new Date().toISOString(), id: Date.now() });
      if (autoReplyLog.length > 200) autoReplyLog.length = 200;
      persistAutoReplyLog();
      res.writeHead(200, CORS); res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(400, CORS); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  // GET /api/auto-reply-log → Dashboard liest Auto-Reply-Verlauf
  if (url.pathname === '/api/auto-reply-log' && req.method === 'GET') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({ ok: true, log: autoReplyLog }));
    return;
  }

  // GET /api/proxy-image?url=<encoded> → Bild mit JOYclub-Session-Cookie proxyen
  // Wird vom Dashboard genutzt um Chat-Fotos anzuzeigen (cfnimg.joyclub.de benötigt Session)
  if (url.pathname === '/api/proxy-image' && req.method === 'GET') {
    const imgUrl = url.searchParams.get('url');
    if (!imgUrl || !imgUrl.startsWith('http')) {
      res.writeHead(400, CORS); res.end('bad url'); return;
    }
    try {
      // latestCookieStr: immer frisch aus Chromium (60s-Sync), Fallback auf NocoDB
      let cookieStr = latestCookieStr;
      if (!cookieStr) {
        const { list } = db.getCookies();
        cookieStr = list?.[0]?.Cookie || '';
      }
      const imgRes = await fetch(imgUrl, {
        headers: {
          'Cookie': cookieStr,
          'Referer': 'https://www.joyclub.de/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!imgRes.ok) { res.writeHead(imgRes.status, CORS); res.end('upstream error'); return; }
      const ct = imgRes.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await imgRes.arrayBuffer());
      res.writeHead(200, { ...CORS, 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
      res.end(buf);
    } catch(e) {
      res.writeHead(502, CORS); res.end(e.message);
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

