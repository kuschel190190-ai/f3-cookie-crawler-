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
    const TIMEOUT = 80_000;
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

        // Prüfen ob bereits auf /clubmail/ → DOM direkt auslesen, kein navigate
        const curR = await send('Runtime.evaluate', { expression: `window.location.href`, returnByValue: true }).catch(() => ({ result: { value: '' } }));
        const curHref = curR.result?.value || '';

        if (!curHref.includes('joyclub.de/clubmail')) {
          await send('Page.navigate', { url: 'https://www.joyclub.de/clubmail/' });
        }

        // Polling bis Konversationsliste MIT Namen erscheint (max 30s)
        for (let i = 0; i < 60; i++) {
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

        // Iteratives Scrollen: Virtual Scroll recycelt DOM-Nodes → pro Iteration sichtbare Items
        // sammeln + akkumulieren, bis keine neuen mehr erscheinen
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
              // Gender: mehrere Fallbacks
              var gender = null;
              var genderEl = entry.querySelector('j-gender-icon');
              if (genderEl) {
                var ug = genderEl.getAttribute('universal-gender') || genderEl.getAttribute('data-universal-gender') || '';
                if (ug === '1') gender = 'Mann';
                else if (ug === '2') gender = 'Frau';
                else if (ug === '3') gender = 'Paar';
                else {
                  var lbl = genderEl.getAttribute('a11y-label') || genderEl.getAttribute('aria-label') || genderEl.getAttribute('title') || '';
                  if (/mann|male/i.test(lbl)) gender = 'Mann';
                  else if (/frau|weib|female/i.test(lbl)) gender = 'Frau';
                  else if (/paar|couple/i.test(lbl)) gender = 'Paar';
                  // Shadow DOM Fallback
                  if (!gender && genderEl.shadowRoot) {
                    var sr = genderEl.shadowRoot;
                    var svgUse = sr.querySelector('use[href],use[xlink\\:href]');
                    var href = svgUse ? (svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || '') : '';
                    if (/male|mann/i.test(href)) gender = 'Mann';
                    else if (/female|frau/i.test(href)) gender = 'Frau';
                    else if (/couple|paar/i.test(href)) gender = 'Paar';
                    if (!gender) {
                      var srText = sr.textContent || '';
                      if (/mann|male/i.test(srText)) gender = 'Mann';
                      else if (/frau|female/i.test(srText)) gender = 'Frau';
                      else if (/paar|couple/i.test(srText)) gender = 'Paar';
                    }
                  }
                }
              }
              // Avatar
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
              items.push({ name, date, preview, avatar, unread, unreadN, gender });
            }
            // Nach dem Extrahieren ans Ende scrollen (Virtual Scroll triggern)
            if (entries.length) {
              var last = entries[entries.length - 1];
              last.scrollIntoView({ block: 'end', behavior: 'instant' });
              var el = last.parentElement;
              while (el) {
                if (el.scrollHeight > el.clientHeight) { el.scrollTop = el.scrollHeight; break; }
                el = el.parentElement;
              }
            }
            return JSON.stringify(items);
          } catch(e) {
            return JSON.stringify([]);
          }
        })()`;

        // Iterativ scrollen + akkumulieren bis keine neuen Namen mehr erscheinen
        const allItemsMap = {};
        for (let s = 0; s < 60; s++) {
          const batchRes = await send('Runtime.evaluate', { expression: itemExtractAndScrollExpr, returnByValue: true })
            .catch(() => ({ result: { value: '[]' } }));
          let batchItems = [];
          try { batchItems = JSON.parse(batchRes.result?.value || '[]'); } catch(e) {}
          let newCount = 0;
          for (const item of batchItems) {
            if (item.name && !allItemsMap[item.name]) {
              allItemsMap[item.name] = item;
              newCount++;
            } else if (item.name && allItemsMap[item.name]) {
              // Update gender/avatar if not set yet
              if (!allItemsMap[item.name].gender && item.gender) allItemsMap[item.name].gender = item.gender;
              if (!allItemsMap[item.name].avatar && item.avatar) allItemsMap[item.name].avatar = item.avatar;
            }
          }
          if (s > 0 && newCount === 0) break;
          await new Promise(r => setTimeout(r, 700));
        }

        clearTimeout(timer);
        ws.close();

        const items = Object.values(allItemsMap).map(i => ({
          id:      i.name,
          url:     'https://www.joyclub.de/clubmail/',
          name:    i.name,
          preview: i.preview,
          avatar:  i.avatar,
          date:    i.date || null,
          unread:  i.unread,
          unreadN: i.unreadN || 0,
          gender:  i.gender || null,
        }));

        resolve({ loggedOut: false, totalCount, items, fetchedAt: new Date().toISOString() });
      } catch(err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ClubMail Thread via CDP – navigiert zur Liste, klickt Eintrag, extrahiert Nachrichten
async function fetchClubMailThreadViaCDP(wsUrl, convId, convName) {
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

    // Nachrichten aus dem gerenderten Thread extrahieren
    const extractExpr = `(function(){
      const bubbles = document.querySelectorAll('.cm-message-bubble__content');
      if (!bubbles.length) return JSON.stringify({ count: 0, path: window.location.pathname });
      const messages = [];
      let dayDividerList = [];
      document.querySelectorAll('[class*="cm-message-day-divider"],[class*="message-day"],[class*="day-divider"]').forEach(d => {
        const text = d.textContent?.trim();
        if (text) dayDividerList.push(text);
      });
      let dividerIdx = 0;
      bubbles.forEach((el, i) => {
        const onlyLinks = el.textContent?.trim().length < 5 && el.querySelector('j-a, a[href]');
        if (onlyLinks) return;
        let html = '';
        const BLOCK = ['P','DIV','SECTION','BLOCKQUOTE','LI','H1','H2','H3','H4'];
        el.childNodes.forEach(n => {
          if (n.nodeName === 'BR') { html += '\\n'; }
          else if (n.nodeName === 'A' || (n.nodeType === 1 && n.tagName === 'A')) {
            html += '[LINK:' + (n.href||'') + ':' + (n.textContent||'') + ']';
          } else if (n.nodeType === 1) {
            const tag = (n.tagName || '').toUpperCase();
            const isBlock = BLOCK.includes(tag);
            const links = n.querySelectorAll('a,[href]');
            if (links.length) {
              if (isBlock && html && !/\\n$/.test(html)) html += '\\n';
              links.forEach(a => { html += '[LINK:' + (a.href||'') + ':' + (a.textContent||'') + ']'; });
              if (isBlock) html += '\\n\\n';
            } else {
              if (isBlock && html && !/\\n$/.test(html)) html += '\\n';
              html += n.textContent || '';
              if (isBlock) html += '\\n\\n';
            }
          } else {
            html += n.textContent || '';
          }
        });
        el.querySelectorAll('j-a').forEach(ja => {
          const href = ja.getAttribute('href') || ja.getAttribute('to') || '';
          const ltext = ja.textContent?.trim() || href;
          html = html.replace(ltext, '[LINK:' + href + ':' + ltext + ']');
        });
        let text = html.trim();
        if (!text) return;
        let own = false;
        let cur = el.parentElement;
        while (cur && cur !== document.body) {
          if (/cm-message-bubble--own/.test(cur.className || '')) { own = true; break; }
          if (/cm-message-bubble--other/.test(cur.className || '')) break;
          cur = cur.parentElement;
        }
        const wrap = el.closest('j-message-bubble') || el.closest('[class*="cm-message-bubble"]');
        const timeEl = wrap ? wrap.querySelector('[class*="time"],[class*="date"],time') : null;
        let sender = '';
        if (!own) {
          const senderEl = wrap ? wrap.querySelector('[class*="sender"],[class*="username"],[class*="name"]') : null;
          sender = senderEl?.textContent?.trim() || '';
        }
        const isKompliment = /kompliment/i.test(wrap?.className || '') || /Kompliment/i.test(text.substring(0,50));
        messages.push({ text: text.substring(0, 1200), own, date: timeEl?.textContent?.trim() || '', sender, isKompliment });
      });
      return JSON.stringify({ count: messages.length, messages, path: window.location.pathname });
    })()`;

    ws.on('open', async () => {
      timer = setTimeout(() => { ws.close(); reject(new Error('Thread CDP Timeout')); }, TIMEOUT);
      try {
        await send('Page.enable');
        const nameToFind = convName || convId;

        // 1. Zur Konversationsliste navigieren + auf Listeneinträge warten
        await send('Page.navigate', { url: 'https://www.joyclub.de/clubmail/' });
        let listReady = false;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const chk = await send('Runtime.evaluate', {
            expression: `document.querySelectorAll('[data-e2e="conversation-list-entry"]').length`,
            returnByValue: true
          });
          if ((chk.result?.value || 0) > 0) { listReady = true; break; }
        }
        if (!listReady) throw new Error('ClubMail-Liste nicht geladen');

        // 2. Eintrag finden, in Viewport scrollen
        const coordRes = await send('Runtime.evaluate', {
          expression: `(function(){
            const entries = document.querySelectorAll('[data-e2e="conversation-list-entry"]');
            for (const e of entries) {
              const n = e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim();
              if (n === ${JSON.stringify(nameToFind)}) {
                e.scrollIntoView({ block: 'center' });
                return JSON.stringify({ found: true, name: n });
              }
            }
            const allNames = [...entries].map(e => e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim()).filter(Boolean);
            return JSON.stringify({ found: false, count: entries.length, names: allNames.slice(0,8) });
          })()`,
          returnByValue: true
        });
        let coords = { found: false };
        try { coords = JSON.parse(coordRes.result?.value || '{}'); } catch(e) {}
        if (!coords.found) throw new Error('Eintrag nicht gefunden: ' + nameToFind + ' (verfügbar: ' + (coords.names||[]).join(', ') + ')');

        await new Promise(r => setTimeout(r, 300));

        // 3. Koordinaten holen und echten Mausklick senden
        const posRes = await send('Runtime.evaluate', {
          expression: `(function(){
            const entries = document.querySelectorAll('[data-e2e="conversation-list-entry"]');
            for (const e of entries) {
              const n = e.querySelector('[data-e2e="conversation-list-item-name"]')?.textContent?.trim();
              if (n === ${JSON.stringify(nameToFind)}) {
                const r = e.getBoundingClientRect();
                return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width, h: r.height });
              }
            }
            return JSON.stringify({ x: 0, y: 0 });
          })()`,
          returnByValue: true
        });
        let pos = { x: 100, y: 200 };
        try { pos = JSON.parse(posRes.result?.value || '{}'); } catch(e) {}

        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });

        // 4. Auf URL-Änderung warten (Vue Router navigiert zu /clubmail/conversation/...)
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

        if (!parsed.count) {
          const dbg = await send('Runtime.evaluate', {
            expression: `JSON.stringify({ path: window.location.pathname, threadUrl: window.__f3_url || '', bubbles: document.querySelectorAll('.cm-message-bubble__content').length })`,
            returnByValue: true
          });
          try { parsed.debugInfo = JSON.parse(dbg.result?.value || '{}'); } catch(e) {}
        }

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
  if (url.pathname === '/messages' && req.method === 'GET') {
    try {
      const wsUrl = await getCDPTarget();
      const result = await fetchClubMailViaCDP(wsUrl);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, totalCount: 0, items: [] }));
    }
    return;
  }

  // GET /messages/:id → Einzelne Konversation lesen (id = convId oder Name, ?name= optional)
  if (url.pathname.match(/^\/messages\/[^/]+$/) && req.method === 'GET') {
    const msgId   = decodeURIComponent(url.pathname.split('/')[2]);
    const msgName = url.searchParams.get('name') ? decodeURIComponent(url.searchParams.get('name')) : msgId;
    let tab = null;
    try {
      tab = await openNewCDPTab();
      const data  = await fetchClubMailThreadViaCDP(tab.wsUrl, msgId, msgName);
      const draftEntry = messageDrafts.get(msgName);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msgId, messages: data.messages || [], debugInfo: data.debugInfo || null, draft: draftEntry?.draft || null }));
    } catch(err) {
      res.writeHead(500, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      if (tab) closeCDPTab(tab.host, tab.tabId).catch(() => {});
    }
    return;
  }

  // POST /messages/send → Nachricht senden { name, text }
  // Nutzt CDP: Chromium ist nach fetchClubMailThreadViaCDP bereits auf der Konversation
  if (url.pathname === '/messages/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { name: convName, url: convUrl, text } = JSON.parse(body || '{}');
        if (!convName || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'name und text erforderlich' }));
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
          ws.on('message', raw => {
            try {
              const msg = JSON.parse(raw);
              if (msg.id && pending[msg.id]) {
                const { res: r2, rej: rj2 } = pending[msg.id];
                delete pending[msg.id];
                if (msg.error) rj2(new Error(msg.error.message));
                else r2(msg.result);
              }
            } catch(e) {}
          });
          ws.on('error', reject);
          ws.on('open', async () => {
            const timer = setTimeout(() => { ws.close(); reject(new Error('Send CDP Timeout')); }, 55000);
            try {
              await send2('Page.enable');

              // Direkt zur Konversations-URL navigieren (nur wenn URL eine Konversations-ID enthält)
              const targetUrl = (convUrl && /joyclub\.de\/clubmail\/\d+/.test(convUrl)) ? convUrl : null;
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

              // Textarea finden und Text eingeben
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
              const typeStatus = typeRes.result?.value || '';
              if (typeStatus === 'no-textarea') throw new Error('Textarea nicht gefunden');

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

              clearTimeout(timer);
              ws.close();
              resolve({ ok: btnStatus.startsWith('sent'), typeStatus, btnStatus });
            } catch(e) {
              clearTimeout(timer);
              ws.close();
              reject(e);
            }
          });
        });


        closeCDPTab(tab.host, tab.tabId).catch(() => {});
        if (result.ok) messageDrafts.delete(convName);
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

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`F3 Cookie Crawler läuft auf Port ${PORT}`);
  console.log(`Chromium: ${CHROME_HOST}:${CHROME_PORT}`);
  console.log(`Filter: ${FILTER_DOMAIN}`);
});

