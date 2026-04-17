// F3 Auto-Post – Sektion mit editierbarem Zeitplan
//
// Datenquelle Phase 1: NocoDB View "post-f3"
// - Wochentag (pro Event): PATCH NocoDB
// - Posting-Zeit (global): PUT n8n workflow cron via API

const AUTOPOST_VIEW_ID   = 'vw9cir6o64c0hg7v';
const AUTOPOST_WF_ID     = 'yqrgx2LvK6gHSyUx';
const WEEKDAYS           = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

// ── Datenabruf ────────────────────────────────────────────────────────────────

function parseEvDate(ev) {
  const m = (ev.EventDatum || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? new Date(+m[3], +m[2]-1, +m[1]) : null;
}
function sortByDate(arr) {
  return arr.sort((a, b) => {
    const da = parseEvDate(a), db2 = parseEvDate(b);
    return (da?.getTime() || 0) - (db2?.getTime() || 0);
  });
}

async function fetchAutopostData() {
  const today = new Date(); today.setHours(0,0,0,0);

  // Alle Events holen (aktiv + abgesagt/verschoben/inaktiv mit Zukunfts-Datum)
  const [aktRes, allRes] = await Promise.all([
    fetch('/api/events?status=aktiv&limit=100', { signal: AbortSignal.timeout(10000) }),
    fetch('/api/events?limit=200',              { signal: AbortSignal.timeout(10000) })
  ]);
  if (!aktRes.ok) throw new Error('API ' + aktRes.status);
  const aktData = await aktRes.json();
  const allData = allRes.ok ? await allRes.json() : { list: [] };

  const records = sortByDate(aktData.list || []);

  // Archiv: abgesagt / verschoben ODER inaktiv mit Zukunftsdatum (noch nicht re-synced)
  const archiv = sortByDate((allData.list || []).filter(ev => {
    if (ev.Status === 'abgesagt' || ev.Status === 'verschoben') return true;
    if (ev.Status === 'inaktiv') {
      const d = parseEvDate(ev);
      return d && d >= today;
    }
    return false;
  }));

  // n8n: aktuelle Posting-Zeit aus Cron lesen (Fehler = Fallback 06:00)
  let postHour = 6, postMinute = 0;
  try {
    const wfRes = await fetch('/proxy/n8n/api/v1/workflows/' + AUTOPOST_WF_ID, {
      headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey },
      signal: AbortSignal.timeout(8000)
    });
    if (wfRes.ok) {
      const wf = await wfRes.json();
      const trigger = (wf.nodes || []).find(n => n.name === '⏰ Mo-Fr 06:00 Uhr1');
      const cron = trigger?.parameters?.rule?.interval?.[0]?.expression || '0 6 * * *';
      const parts = cron.split(' ');
      postMinute = parseInt(parts[0]) || 0;
      postHour   = parseInt(parts[1]) || 6;
    }
  } catch(e) {
    console.warn('[autopost] n8n cron fetch failed, using default 06:00', e.message);
  }

  return { records, archiv, postHour, postMinute };
}

// ── n8n Cron aktualisieren ────────────────────────────────────────────────────

async function updatePostingTime(hour, minute) {
  // 1. Workflow holen
  const wfRes = await fetch('/proxy/n8n/api/v1/workflows/' + AUTOPOST_WF_ID, {
    headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey },
    signal: AbortSignal.timeout(10000)
  });
  if (!wfRes.ok) throw new Error('n8n Workflow fetch ' + wfRes.status);
  const wf = await wfRes.json();

  // 2. Cron aktualisieren
  const h = String(hour).padStart(2, '0');
  const m = String(minute).padStart(2, '0');
  const newCron = `${minute} ${hour} * * *`;
  wf.nodes = (wf.nodes || []).map(n => {
    if (n.name === '⏰ Mo-Fr 06:00 Uhr1') {
      n.parameters.rule.interval[0].expression = newCron;
    }
    return n;
  });

  // 3. Workflow zurückschreiben
  const { executionOrder, errorWorkflow, callerPolicy } = wf.settings || {};
  const putRes = await fetch('/proxy/n8n/api/v1/workflows/' + AUTOPOST_WF_ID, {
    method: 'PUT',
    headers: {
      'X-N8N-API-KEY': CONFIG.n8n.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: { executionOrder, errorWorkflow, callerPolicy },
      staticData: wf.staticData || null
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error('n8n PUT ' + putRes.status + ': ' + err.substring(0, 100));
  }

  // 4. Reaktivieren
  await fetch('/proxy/n8n/api/v1/workflows/' + AUTOPOST_WF_ID + '/activate', {
    method: 'POST',
    headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey },
    signal: AbortSignal.timeout(8000)
  });

  return `${h}:${m}`;
}

// ── NocoDB Wochentag aktualisieren ────────────────────────────────────────────

async function updateWochentag(recordId, wochentag) {
  const res = await fetch('/api/events/' + recordId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Wochentag: wochentag }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('API PATCH ' + res.status);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderAutopost(container, { records, archiv, postHour, postMinute }) {
  // ── Delta-Snapshot laden (wird in renderAutopostCard verwendet) ──
  const snap = loadStatsSnapshot();
  _statsSnap = snap;
  // Snapshot nach 24h erneuern
  if (!snap || (Date.now() - (snap.ts || 0)) > SNAP_MAX_AGE_MS) {
    saveStatsSnapshot(records);
    _statsSnap = null; // erste Messung: kein Delta anzeigen
  }

  const badge = document.getElementById('section-autopost-badge');
  if (badge) {
    badge.className = 'wf-status-badge status-ok';
    badge.querySelector('.wf-status-icon').textContent = '✓';
    badge.querySelector('.wf-status-text').textContent = records.length + ' Events';
  }

  const hStr = String(postHour).padStart(2, '0');
  const mStr = String(postMinute).padStart(2, '0');

  const cookiesExpired = window.f3CookieOk === false;

  container.innerHTML =
    // ── Cookie-Warnung wenn abgelaufen ──
    (cookiesExpired
      ? '<div class="autopost-cookie-warning" style="background:rgba(255,50,50,0.12);border:1px solid var(--pink);border-radius:6px;padding:0.5rem 0.75rem;margin-bottom:0.75rem;font-size:0.82rem;display:flex;align-items:center;gap:0.5rem">'
        + '⚠ JoyClub Cookies abgelaufen — bitte zuerst '
        + '<a href="#wf-cookie-crawler" style="color:var(--pink)" onclick="document.getElementById(\'wf-cookie-crawler\').scrollIntoView({behavior:\'smooth\'});return false">Cookies holen</a>'
        + ' oder '
        + '<a href="#wf-joyclub-login" style="color:var(--pink)" onclick="document.getElementById(\'wf-joyclub-login\').scrollIntoView({behavior:\'smooth\'});return false">Auto-Login</a>'
        + '</div>'
      : '')

    // ── Jetzt Pushen ──
    + '<div class="autopost-push-bar">'
    + '<span class="autopost-push-label">🚀 Jetzt Pushen</span>'
    + '<select id="ap-push-select" class="autopost-push-select"' + (cookiesExpired ? ' disabled' : '') + '>'
    +   '<option value="">Event wählen…</option>'
    +   records.map(ev => '<option value="' + ev.Id + '" data-name="' + (ev.EventName||'') + '">' + (ev.EventName||'—') + (ev.EventDatum ? '  ·  ' + ev.EventDatum : '') + '</option>').join('')
    + '</select>'
    + '<button id="ap-push-btn" class="autopost-push-btn"' + (cookiesExpired ? ' disabled title="Cookies müssen zuerst aktualisiert werden" style="opacity:0.45;cursor:not-allowed"' : '') + '>Jetzt Pushen</button>'
    + '<span id="ap-push-hint" class="autopost-push-hint">' + (cookiesExpired ? '⚠ Cookies abgelaufen' : '') + '</span>'
    + '</div>'

    // ── Globale Posting-Zeit ──
    + '<div class="autopost-schedule-bar">'
    + '<span class="autopost-schedule-label">⏰ Tägliche Posting-Zeit</span>'
    + '<div class="autopost-time-wrap">'
    +   '<input type="number" class="autopost-time-input" id="ap-hour" min="0" max="23" value="' + postHour + '">'
    +   '<span class="autopost-time-sep">:</span>'
    +   '<input type="number" class="autopost-time-input" id="ap-minute" min="0" max="59" value="' + postMinute + '">'
    + '</div>'
    + '<button class="autopost-save-time" id="ap-save-time">Speichern</button>'
    + '<span class="autopost-time-hint">' + hStr + ':' + mStr + ' Uhr · täglich</span>'
    + '</div>'

    // ── Event-Karten ──
    + '<div class="autopost-list">'
    + (records.length === 0
        ? '<p style="color:var(--muted)">Keine aktiven Events.</p>'
        : records.map(ev => renderAutopostCard(ev)).join(''))

    // ── Archiv: Abgesagt / Verschoben ──
    + (archiv.length
        ? '<details class="autopost-archiv" style="margin-top:1rem">'
          + '<summary style="cursor:pointer;font-size:0.82rem;color:var(--muted,#888);padding:0.3rem 0;list-style:none;display:flex;align-items:center;gap:0.4rem">'
          + '▸ Archiv – Abgesagt / Verschoben (' + archiv.length + ')</summary>'
          + archiv.map(ev => {
              const sc = ev.Status === 'abgesagt' ? '#e85656' : ev.Status === 'verschoben' ? '#e8a556' : '#888';
              const label = ev.Status === 'abgesagt' ? '✗ Abgesagt' : ev.Status === 'verschoben' ? '⟳ Verschoben' : '⏸ Inaktiv';
              return '<div class="autopost-card" style="opacity:0.55;border-left-color:' + sc + ';margin-top:0.4rem">'
                + '<div class="autopost-card-header">'
                +   (ev.EventDatum ? '<span class="autopost-card-date">📅 ' + ev.EventDatum + '</span>' : '')
                +   '<span class="autopost-card-name">' + (ev.EventLink
                      ? '<a href="' + ev.EventLink + '" target="_blank" rel="noopener" style="color:var(--text,#eee);text-decoration:none">' + (ev.EventName||'—') + '</a>'
                      : (ev.EventName||'—')) + '</span>'
                +   '<span style="font-size:0.75rem;padding:0.15rem 0.45rem;border-radius:4px;background:' + sc + '22;color:' + sc + '">' + label + '</span>'
                + '</div>'
                + '</div>';
            }).join('')
          + '</details>'
        : '')

    + '</div>';

  // Bind: Jetzt Pushen
  document.getElementById('ap-push-btn')?.addEventListener('click', async () => {
    const sel  = document.getElementById('ap-push-select');
    const hint = document.getElementById('ap-push-hint');
    const eventId   = sel?.value;
    const eventName = sel?.options[sel.selectedIndex]?.text?.split('  ·')[0]?.trim() || sel?.options[sel.selectedIndex]?.dataset.name;
    if (!eventId) {
      if (hint) { hint.textContent = '⚠ Bitte zuerst ein Event wählen'; hint.className = 'autopost-push-hint hint-warn'; }
      return;
    }

    if (window.f3CookieOk === false) {
      if (hint) { hint.textContent = '⚠ Cookies abgelaufen – bitte zuerst Cookie-Sync oder Auto-Login'; hint.className = 'autopost-push-hint hint-warn'; }
      return;
    }
    const btn = document.getElementById('ap-push-btn');
    btn.disabled = true; btn.textContent = '⏳ Wird gepostet…';
    if (hint) { hint.textContent = '⏳ n8n Workflow läuft (~30s)…'; hint.className = 'autopost-push-hint hint-info'; }

    try {
      // Über nginx-Proxy routen (vermeidet CORS)
      const webhookPath = '/proxy/n8n/webhook/f3-autopush-manual';
      const res = await fetch(webhookPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, eventName }),
        signal: AbortSignal.timeout(90000)
      });
      if (!res.ok) throw new Error('n8n HTTP ' + res.status);
      const body = await res.text();
      if (hint) {
        hint.textContent = '✓ Erfolgreich gepostet: ' + eventName;
        hint.className = 'autopost-push-hint hint-ok';
      }
      btn.textContent = '✓ Gepostet';
    } catch(err) {
      const msg = err.name === 'TimeoutError' ? 'Timeout – n8n hat nicht geantwortet (>90s)' : err.message;
      if (hint) { hint.textContent = '✗ Fehler: ' + msg; hint.className = 'autopost-push-hint hint-error'; }
      btn.textContent = 'Jetzt Pushen';
      btn.disabled = false;
      return;
    }
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Jetzt Pushen'; if (hint) { hint.textContent = ''; hint.className = 'autopost-push-hint'; } }, 5000);
  });

  // Bind: Posting-Zeit speichern
  document.getElementById('ap-save-time')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const hour   = parseInt(document.getElementById('ap-hour').value)   || 0;
    const minute = parseInt(document.getElementById('ap-minute').value) || 0;
    btn.disabled = true; btn.textContent = '⏳';
    try {
      const result = await updatePostingTime(hour, minute);
      btn.textContent = '✓ Gespeichert';
      document.querySelector('.autopost-time-hint').textContent = result + ' Uhr · täglich';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Speichern'; }, 2000);
    } catch(err) {
      btn.textContent = '✗ Fehler';
      btn.title = err.message;
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Speichern'; }, 3000);
    }
  });

  // Bind: Wochentag-Checkboxen pro Event
  container.querySelectorAll('.autopost-day-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('[data-record-id]');
      const recordId = card?.dataset.recordId;
      if (!recordId) return;

      btn.classList.toggle('active');

      // Aktive Tage sammeln
      const activeDays = [...card.querySelectorAll('.autopost-day-btn.active')]
        .map(b => b.dataset.day);
      const wochentag = activeDays.join(',');

      // Status anzeigen
      const hint = card.querySelector('.autopost-day-hint');
      if (hint) hint.textContent = '⏳ Speichere…';

      try {
        await updateWochentag(recordId, wochentag);
        if (hint) hint.textContent = wochentag || '—';
      } catch(err) {
        if (hint) hint.textContent = '✗ Fehler: ' + err.message;
      }
    });
  });
}

// ── Stats-Snapshot (24h-Delta) ────────────────────────────────────────────────
const SNAP_KEY = 'f3_stats_snap';
const SNAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadStatsSnapshot() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY)); } catch { return null; }
}
function saveStatsSnapshot(records) {
  const ev = {};
  records.forEach(r => {
    if (r.Id) ev[r.Id] = { Angemeldet: r.Angemeldet, Maenner: r.Maenner, Frauen: r.Frauen, Paare: r.Paare, Vorgemerkt: r.Vorgemerkt, Aufrufe: r.Aufrufe };
  });
  localStorage.setItem(SNAP_KEY, JSON.stringify({ ts: Date.now(), ev }));
}
function getSnapDelta(snap, id, field) {
  if (!snap?.ev?.[id]) return null;
  return null; // only used when called from renderAutopostCard where snap is in scope
}

function apStat(label, val, color, delta) {
  if (val === null || val === undefined || val === '') return '';
  let deltaHtml = '';
  if (delta !== null && delta !== undefined && delta !== 0) {
    const sign = delta > 0 ? '+' : '';
    const dcol = delta > 0 ? '#4caf50' : '#e85656';
    deltaHtml = '<span style="font-size:0.65rem;color:' + dcol + ';display:block;line-height:1">' + sign + delta + '</span>';
  }
  return '<div style="text-align:center;min-width:48px;flex:1">'
    + '<div style="font-size:0.68rem;color:var(--muted,#888);margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em">' + label + '</div>'
    + '<div style="font-size:1rem;font-weight:700;color:' + (color || 'var(--text,#eee)') + '">' + val + '</div>'
    + deltaHtml
    + '</div>';
}

let _statsSnap = null; // set in renderAutopost before rendering cards

function renderAutopostCard(ev) {
  const name      = ev.EventName || '—';
  const datum     = ev.EventDatum || '';
  const preise    = (ev.Preise || '').trim();
  const wochentag = (ev.Wochentag || '').replace(/\s/g, '');
  const activeDays = wochentag ? wochentag.split(',') : [];

  const dayBtns = WEEKDAYS.map(d =>
    '<button class="autopost-day-btn' + (activeDays.includes(d) ? ' active' : '') + '" data-day="' + d + '">' + d + '</button>'
  ).join('');

  const hasStats = ev.Angemeldet || ev.Maenner || ev.Frauen || ev.Aufrufe;

  // Delta aus Snapshot
  const prevEv = _statsSnap?.ev?.[ev.Id];
  function d(field) { return prevEv && ev[field] != null ? (ev[field] - (prevEv[field] || 0)) : null; }

  // ── Rechte Spalte: Stats + Preise ──
  const rightCol = '<div style="display:flex;flex-direction:column;gap:0.4rem;min-width:0;flex:1;border-left:1px solid rgba(255,255,255,0.08);padding-left:0.75rem">'
    + (hasStats
        ? '<div style="display:flex;gap:0.4rem;flex-wrap:wrap">'
          + apStat('Angemeldet', ev.Angemeldet, null,      d('Angemeldet'))
          + apStat('Männer',     ev.Maenner,    '#4dd9e0', d('Maenner'))
          + apStat('Frauen',     ev.Frauen,     '#e040a0', d('Frauen'))
          + apStat('Paare',      ev.Paare,      '#b060e8', d('Paare'))
          + apStat('Vorgemerkt', ev.Vorgemerkt, null,      d('Vorgemerkt'))
          + apStat('Aufrufe',    ev.Aufrufe,    null,      d('Aufrufe'))
          + '</div>'
        : '<div style="color:var(--muted,#666);font-size:0.78rem">Noch keine Stats</div>')
    + (preise
        ? '<details style="font-size:0.78rem;margin-top:0.1rem">'
          + '<summary style="cursor:pointer;color:var(--accent,#c074e8);list-style:none">🎟 Preise</summary>'
          + '<div style="padding:0.2rem 0;color:var(--text,#eee);font-size:0.82rem">' + preise + '</div>'
          + '</details>'
        : '')
    + '</div>';

  return '<div class="autopost-card" data-record-id="' + ev.Id + '">'
    + '<div style="display:flex;gap:0.6rem;align-items:flex-start">'

    // ── Linke Spalte: Datum + Name + Wochentage ──
    + '<div style="flex:0 0 auto;min-width:0;display:flex;flex-direction:column;gap:0.35rem">'
    +   '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">'
    +     (datum ? '<span class="autopost-card-date">📅 ' + datum + '</span>' : '')
    +     (ev.EventLink
            ? '<a class="autopost-card-name" href="' + ev.EventLink + '" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">' + name + '</a>'
            : '<span class="autopost-card-name">' + name + '</span>')
    +   '</div>'
    +   '<div class="autopost-days-row" style="margin:0">'
    +     '<span class="autopost-days-label">Wochentage</span>'
    +     '<div class="autopost-days">' + dayBtns + '</div>'
    +     '<span class="autopost-day-hint">' + (wochentag || '—') + '</span>'
    +   '</div>'
    + '</div>'

    + rightCol
    + '</div>'
    + '</div>';
}
