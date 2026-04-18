// F3 Dashboard – Dynamische Workflow-Karten aus n8n API

async function fetchAllWorkflows() {
  const res = await fetch(CONFIG.n8n.baseUrl + '/api/v1/workflows?limit=100', {
    headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey }
  });
  if (!res.ok) throw new Error('n8n API ' + res.status);
  const data = await res.json();
  return (data.data || []).filter(wf => wf.name.startsWith('F3'));
}

// ── Shared Workflow Cache (für andere Dashboard-Komponenten) ──────────────────

let _wfCache = null;
let _wfCachePending = null;

function clearWorkflowCache() {
  _wfCache = null;
  _wfCachePending = null;
}

async function fetchAllWorkflowsCached() {
  if (_wfCache) return _wfCache;
  if (_wfCachePending) return _wfCachePending;
  _wfCachePending = fetchAllWorkflows().then(wfs => {
    _wfCache = wfs;
    _wfCachePending = null;
    return wfs;
  });
  return _wfCachePending;
}

// Workflow-Ausführungsdaten nach Name (partial match, case-insensitive)
async function getWorkflowExecsByName(name) {
  const all = await fetchAllWorkflowsCached();
  const lower = name.toLowerCase();
  const wf = all.find(w => w.name.toLowerCase().includes(lower));
  if (!wf) return null;
  const execs = await fetchWorkflowExecutions(wf.id);
  return { name: wf.name, id: wf.id, active: wf.active, executions: execs };
}

async function fetchWorkflowExecutions(workflowId) {
  try {
    const res = await fetch(
      CONFIG.n8n.baseUrl + '/api/v1/executions?workflowId=' + workflowId + '&limit=3&includeData=false',
      { headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  } catch {
    return [];
  }
}

// Workflows mit eigener Dashboard-Sektion oder eigenem Card – hier nicht doppelt zeigen
const WF_EXCLUDED_PATTERNS = ['autopost', 'cookie'];

async function fetchDynamicWorkflowsData() {
  const workflows = await fetchAllWorkflowsCached();

  const withExecs = await Promise.all(workflows.map(async wf => {
    const execs = await fetchWorkflowExecutions(wf.id);
    return { ...wf, executions: execs };
  }));

  // Deduplizieren: gleicher Name → aktive Version bevorzugen, dann neueste Ausführung
  const nameMap = new Map();
  for (const wf of withExecs) {
    const key = wf.name.trim().toLowerCase();
    const existing = nameMap.get(key);
    if (!existing) {
      nameMap.set(key, wf);
    } else {
      const existActive = existing.active ? 1 : 0;
      const newActive   = wf.active       ? 1 : 0;
      if (newActive > existActive) {
        nameMap.set(key, wf);
      } else if (newActive === existActive) {
        const existDate = existing.executions[0]?.startedAt || '';
        const newDate   = wf.executions[0]?.startedAt       || '';
        if (newDate > existDate) nameMap.set(key, wf);
      }
    }
  }

  // Workflows mit eigener Sektion ausfiltern + inaktive ausblenden
  let deduped = Array.from(nameMap.values()).filter(wf => {
    const lower = wf.name.toLowerCase();
    if (WF_EXCLUDED_PATTERNS.some(p => lower.includes(p))) return false;
    const isAlwaysShow = WF_ALWAYS_SHOW.some(k => lower.includes(k));
    return wf.active || isAlwaysShow;
  });

  // Sortieren: Fehler zuerst, dann nach Name
  deduped.sort((a, b) => {
    const aErr = a.executions[0]?.status === 'error' ? 0 : 1;
    const bErr = b.executions[0]?.status === 'error' ? 0 : 1;
    if (aErr !== bErr) return aErr - bErr;
    return a.name.localeCompare(b.name);
  });

  return deduped;
}

function renderDynamicWorkflows(container, workflows) {
  // Section-Badge aktualisieren
  const badge = document.getElementById('section-workflows-badge');
  if (badge) {
    const hasError = workflows.some(wf => wf.executions[0]?.status === 'error');
    const allGood  = workflows.every(wf => !wf.executions[0] || wf.executions[0].status === 'success');
    if (hasError) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = 'Fehler';
    } else if (allGood) {
      badge.className = 'wf-status-badge status-ok';
      badge.querySelector('.wf-status-icon').textContent = '✓';
      badge.querySelector('.wf-status-text').textContent = workflows.length + ' Workflows';
    } else {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '⚠';
      badge.querySelector('.wf-status-text').textContent = 'Warnung';
    }
  }

  container.innerHTML = '<div class="wf-list">' +
    workflows.map(renderDynamicCard).join('') +
  '</div>';

  // Toggle-Listener für dynamisch gerenderte Karten
  container.querySelectorAll('.wf-toggle').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('a') || e.target.closest('.wf-note-btn')) return;
      const card  = hdr.closest('.wf-card');
      const body  = card?.querySelector('.wf-body');
      const arrow = hdr.querySelector('.wf-card-toggle');
      if (!body) return;
      const collapsed = body.classList.toggle('wf-collapsed');
      if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
    });
  });

  // Note-Button: Sticky-Note-Popover öffnen
  container.querySelectorAll('.wf-note-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const wfId = btn.dataset.wfId;
      const card = btn.closest('.wf-card');
      const wfName = card?.querySelector('.wf-title')?.textContent || '';
      const note = getWfNote(wfName);
      if (note) showWfNote(wfId, note, btn);
    });
  });
}

function relativeTime(dateStr) {
  if (!dateStr) return '—';
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000);
  if (mins < 1)   return 'gerade eben';
  if (mins < 60)  return 'vor ' + mins + ' min';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return 'vor ' + hours + ' h';
  return 'vor ' + Math.floor(hours / 24) + ' d';
}

function execDots(executions) {
  return '<div class="exec-dots">' + [0,1,2].map(i => {
    const e = executions[i];
    if (!e) return '<span class="exec-dot exec-dot-empty" title="—"></span>';
    const cls = e.status === 'success' ? 'exec-dot-ok' : e.status === 'error' ? 'exec-dot-err' : 'exec-dot-warn';
    return '<span class="exec-dot ' + cls + '" title="' + e.status + '"></span>';
  }).join('') + '</div>';
}

// Datenquelle & Login pro Workflow
const WF_META = [
  { match: 'autopost',       source: 'SQLite',          login: false },
  { match: 'cookie',         source: 'SQLite',          login: true  },
  { match: 'joyclub-sync',   source: 'JoyClub',         login: true  },
  { match: 'joyclub sync',   source: 'JoyClub',         login: true  },
  { match: 'sync',           source: 'JoyClub',         login: true  },
  { match: 'stats',          source: 'JoyClub',         login: false },
  { match: 'events api',     source: 'SQLite',          login: false },
  { match: 'website',        source: 'SQLite',          login: false },
  { match: 'benachrichtig',  source: 'JoyClub',         login: true  },
  { match: 'ladies',         source: 'SQLite + JoyClub',login: true  },
  { match: 'voting',         source: 'SQLite + JoyClub',login: true  },
];

// Workflow-Beschreibungen für Sticky-Note-Popover
const WF_NOTES = [
  {
    match: '1a',
    title: '1a – Auto-Login',
    was: 'Täglich 04:00 Uhr: Loggt automatisch in JOYclub ein via CDP/Chromium, speichert Session-Cookies in der DB.',
    ok:   'Login & Cookie-Speicherung funktionieren zuverlässig.',
    nok:  '—',
  },
  {
    match: '1 –',
    title: '1 – Cookie Sync',
    was: 'Stündlich: Prüft ob die JOYclub-Session noch aktiv ist. Triggert Auto-Login falls abgelaufen.',
    ok:   'Session-Prüfung + Trigger läuft stabil.',
    nok:  '—',
  },
  {
    match: '2 –',
    title: '2 – Event + Teilnehmer Sync',
    was: 'Täglich: Scrapt alle Events + Teilnehmer von JOYclub, aktualisiert die Events-Tabelle in SQLite.',
    ok:   'Event-Scraping funktioniert.',
    nok:  'Teilnehmer-Zählung kann durch HTML-Änderungen bei JOYclub brechen.',
  },
  {
    match: '3 –',
    title: '3 – Autopost',
    was: 'Täglich Mo/Do: Postet das aktive Event auf JOYclub-Statusseite mit Bild + Link. Holt Cookie aus DB.',
    ok:   'Posting funktioniert wenn Event-Bild gesetzt ist.',
    nok:  'Bricht wenn EventBild leer oder JOYclub-DOM sich ändert.',
  },
  {
    match: 'lv 0',
    title: 'LV 0 – Kandidaten-Scan',
    was: 'Täglich: Scrapt neue Ladies-Voting-Kandidatinnen aus JOYclub-Profilen, speichert in SQLite.',
    ok:   'Profil-Scraping + DB-Insert stabil.',
    nok:  '—',
  },
  {
    match: 'lv 1',
    title: 'LV 1 – Profil-Scraper',
    was: 'Scrapt Fotos + Details von Kandidatinnen-Profilen.',
    ok:   'Funktioniert.',
    nok:  '—',
  },
  {
    match: 'lv 2',
    title: 'LV 2 – Voting-Nachricht',
    was: 'Schickt wöchentlich donnerstags die Voting-Nachricht an alle Kandidatinnen via Telegram.',
    ok:   'Versand stabil.',
    nok:  '—',
  },
  {
    match: 'lv status',
    title: 'LV Status API',
    was: 'Webhook-API: Gibt aktuellen Voting-Status zurück (nächster Donnerstag, letzter Sync). Wird vom Dashboard abgerufen.',
    ok:   'API antwortet korrekt.',
    nok:  '—',
  },
  {
    match: '5 –',
    title: '5 – Message Drafts (KI-Antworten)',
    was: 'Läuft bei neuen ungelesenen ClubMail-Nachrichten. Generiert KI-Antwort-Entwürfe via Claude. Erkennt: Kompliment (→ skip), Anfrage (→ Draft), Anmeldung ohne Foto (→ Auto-Reply), Foto nach Warteliste (→ FOTO_EINGEGANGEN-Draft).',
    ok:   'Alle 4 Szenarien funktionieren. Bild-Erkennung (isImage) korrekt.',
    nok:  'imageUrl manchmal leer (JOYclub lazy-load) – irrelevant für Draft-Generierung.',
  },
  {
    match: '6 –',
    title: '6 – Event Knowledge Base',
    was: 'Scrapt F3-Profil-Homepages (Preise, Dresscode, Hygiene-Regeln, LV-Regeln) und speichert als Kontext für WF5.',
    ok:   'Scraping + Speicherung funktioniert.',
    nok:  '—',
  },
];

function getWfNote(name) {
  const lower = name.toLowerCase();
  return WF_NOTES.find(n => lower.includes(n.match.toLowerCase())) || null;
}

// Singleton-Popover – nur einer gleichzeitig sichtbar
let _wfNoteOpenId = null;
function showWfNote(id, note, anchorEl) {
  // Existing popover schließen
  document.getElementById('wf-note-popover')?.remove();
  if (_wfNoteOpenId === id) { _wfNoteOpenId = null; return; }
  _wfNoteOpenId = id;

  const pop = document.createElement('div');
  pop.id = 'wf-note-popover';
  pop.className = 'wf-note-popover';
  pop.innerHTML = `
    <div class="wf-note-header">
      <span class="wf-note-title">📋 ${note.title}</span>
      <button class="wf-note-close" onclick="document.getElementById('wf-note-popover')?.remove();_wfNoteOpenId=null">✕</button>
    </div>
    <div class="wf-note-section"><strong>Was macht es?</strong><p>${note.was}</p></div>
    <div class="wf-note-section wf-note-ok"><strong>✓ Funktioniert</strong><p>${note.ok}</p></div>
    ${note.nok && note.nok !== '—' ? `<div class="wf-note-section wf-note-nok"><strong>⚠ Noch offen / bekannte Probleme</strong><p>${note.nok}</p></div>` : ''}
  `;

  // Schließen bei Klick außerhalb
  const closeHandler = e => {
    if (!pop.contains(e.target) && !e.target.closest('.wf-note-btn')) {
      pop.remove();
      _wfNoteOpenId = null;
      document.removeEventListener('click', closeHandler, true);
    }
  };
  document.addEventListener('click', closeHandler, true);

  // Position: unter dem Anker-Element
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  const popW = 340;
  let left = Math.min(rect.left, window.innerWidth - popW - 12);
  left = Math.max(left, 8);
  pop.style.left = left + 'px';
  pop.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
}

// Workflows die NICHT ausgegraut werden (auch wenn inaktiv)
const WF_ALWAYS_SHOW = ['benachrichtig'];

function getWfMeta(name) {
  const lower = name.toLowerCase();
  return WF_META.find(m => lower.includes(m.match)) || { source: '—', login: false };
}

function renderDynamicCard(wf) {
  const lastExec = wf.executions[0];
  const meta = getWfMeta(wf.name);
  const isAlwaysShow = WF_ALWAYS_SHOW.some(k => wf.name.toLowerCase().includes(k));
  const isInactive = !wf.active && !isAlwaysShow;

  let cls  = 'status-unknown';
  let icon = '◷';
  let text = 'Keine Ausführung';
  let hasError = false;

  if (isInactive) {
    cls = 'status-unknown'; icon = '—'; text = 'Inaktiv';
  } else if (lastExec) {
    if (lastExec.status === 'success')    { cls = 'status-ok';    icon = '✓'; text = 'OK'; }
    else if (lastExec.status === 'error') { cls = 'status-error'; icon = '✗'; text = 'Fehler'; hasError = true; }
    else                                  { cls = 'status-warn';  icon = '⚠'; text = lastExec.status; }
  } else if (wf.active) {
    cls = 'status-ok'; icon = '✓'; text = 'Aktiv';
  }

  const duration = (lastExec?.stoppedAt && lastExec?.startedAt)
    ? Math.round((new Date(lastExec.stoppedAt) - new Date(lastExec.startedAt)) / 1000) + ' s'
    : '—';

  const activeIcon = wf.active
    ? '<span class="pulse-dot"></span><span class="wf-icon">⚡</span>'
    : '<span class="wf-icon">⏸</span>';

  const sourceBadge = '<span class="wf-source-badge">' + meta.source + '</span>';
  const loginBadge  = meta.login
    ? '<span class="wf-login-badge" title="JoyClub Login erforderlich">🔐</span>'
    : '';

  const note = getWfNote(wf.name);
  const noteBtn = note
    ? '<button class="wf-note-btn" data-wf-id="' + wf.id + '" title="Was macht dieser Workflow?">📋</button>'
    : '';

  return '<div class="wf-card' + (hasError ? ' has-error' : '') + (isInactive ? ' wf-inactive' : '') + '" data-wf-id="' + wf.id + '">'
    + '<div class="wf-header wf-toggle">'
    +   '<span class="wf-card-toggle">▼</span>'
    +   '<div class="wf-title-group">'
    +     activeIcon
    +     '<a class="wf-title wf-title-link" href="https://n8n.f3-events.de/workflow/' + wf.id + '" target="_blank" rel="noopener">' + wf.name + '</a>'
    +     loginBadge
    +     sourceBadge
    +     noteBtn
    +   '</div>'
    +   '<div class="wf-status-badge ' + cls + '">'
    +     '<span class="wf-status-icon">' + icon + '</span>'
    +     '<span class="wf-status-text">' + text + '</span>'
    +   '</div>'
    + '</div>'
    + '<div class="wf-body">'
    +   '<div class="wf-divider"></div>'
    +   '<table class="wf-table">'
    +     '<tr><td class="wf-label">Datenquelle</td><td class="wf-value">' + meta.source + '</td></tr>'
    +     '<tr><td class="wf-label">Login nötig</td><td class="wf-value">' + (meta.login ? '🔐 Ja' : '✓ Nein') + '</td></tr>'
    +     '<tr><td class="wf-label">Letzte Ausführung</td><td class="wf-value">' + relativeTime(lastExec?.startedAt) + '</td></tr>'
    +     '<tr><td class="wf-label">Dauer</td><td class="wf-value">' + duration + '</td></tr>'
    +     '<tr><td class="wf-label">Letzte 3</td><td class="wf-value">' + execDots(wf.executions) + '</td></tr>'
    +   '</table>'
    + '</div>'
    + '</div>';
}
