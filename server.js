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

function parseJoyclubNotifications(html, finalUrl) {
  if (/identity\.joyclub|\/login|logged_out/i.test(finalUrl)) {
    return { loggedOut: true, totalCount: 0, items: [] };
  }

  // data-notification-count ist das zuverlässigste Attribut (JOYclub Nav)
  const countMatch = html.match(/data-notification-count="(\d+)"/) ||
                     html.match(/class="counter_badge">(\d+)</) ||
                     html.match(/counter_badge[^>]*>(\d+)</);
  const totalCount = countMatch ? parseInt(countMatch[1]) : 0;

  const TYPE_MAP = {
    event_registration: { label: 'Eventanmeldung', icon: '🎟' },
    event_cancellation: { label: 'Stornierung',    icon: '❌' },
    cancellation:       { label: 'Stornierung',    icon: '❌' },
    fan:                { label: 'Neuer Fan',       icon: '⭐' },
    message:            { label: 'Nachricht',       icon: '💬' },
    profile_view:       { label: 'Profilbesuch',    icon: '👁' },
    comment:            { label: 'Kommentar',       icon: '💬' },
    group_join:         { label: 'Beitritt',        icon: '👥' },
    like:               { label: 'Like',            icon: '❤️' },
    photo:              { label: 'Foto',            icon: '📷' },
  };

  const items = [];
  const blocks = html.split('notification-object-type=');

  for (let i = 1; i < blocks.length && items.length < 25; i++) {
    const block = blocks[i];
    const typeMatch = block.match(/^["']([^"']{1,60})["']/);
    if (!typeMatch) continue;
    const type = typeMatch[1].trim();
    const meta = TYPE_MAP[type] || { label: type, icon: '🔔' };

    const chunk = block.substring(0, 3000);

    // URL: /event/ oder /profil/
    const urlMatch = chunk.match(/href="(\/(?:event\/\d+|profil\/[^"]+|benachrichtigung)[^"]*)"/);
    const itemUrl = urlMatch
      ? 'https://www.joyclub.de' + urlMatch[1]
      : 'https://www.joyclub.de/benachrichtigung/';

    // Alle Texte aus Tags extrahieren
    const texts = [...chunk.matchAll(/>([^<\n]{3,120})</g)]
      .map(m => m[1].trim().replace(/\s+/g, ' '))
      .filter(t => t.length > 2);

    // "1 Stornierung" / "2 Eventanmeldungen"
    const summary = texts.find(t => /^\d+\s+\w/i.test(t)) || `1 ${meta.label}`;

    // Entitätsname: längster Text ohne Datum/Uhrzeit/Zähler-Muster
    const entityName = texts
      .filter(t =>
        t.length > 6 &&
        !/^\d+\s+\w/.test(t) &&
        !/^\d{2}\.\d{2}/.test(t) &&
        !/^\d{1,2}:\d{2}$/.test(t) &&
        !/^(vor|am|um|heute|gestern|jetzt|alle)/i.test(t)
      )
      .sort((a, b) => b.length - a.length)[0] || null;

    const dateMatch = chunk.match(/(\d{2}\.\d{2}\.\d{4})/);
    const timeMatch = chunk.match(/[^\d](\d{2}:\d{2})[^\d]/);
    const unread    = !/notification-item--read|is-read\b|"read"/i.test(chunk);

    items.push({
      type,
      icon:       meta.icon,
      label:      meta.label,
      summary,
      entityName: entityName || null,
      url:        itemUrl,
      date:       dateMatch ? dateMatch[1] : null,
      time:       timeMatch ? timeMatch[1] : null,
      unread,
    });
  }

  return { loggedOut: false, totalCount, items, fetchedAt: new Date().toISOString() };
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
      db.getCookies().then(({ list }) => {
        const rowId = list?.[0]?.Id || 1;
        return db.updateCookies(rowId, { Cookie: cookieString, Ablaufdatum: ablaufdatum });
      }).catch(() => {});

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

  // GET /notifications → JOYclub Benachrichtigungen via Cookie-HTTP-Fetch
  if (url.pathname === '/notifications') {
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

