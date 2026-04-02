// F3 Dashboard – Haupt-Logic

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function formatDateTime(date) {
  return date.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderRows(container, rows) {
  const table = container.querySelector('.wf-table');
  table.innerHTML = rows.map(r => `
    <tr>
      <td class="wf-label">${r.label}</td>
      <td class="wf-value">${r.value}</td>
    </tr>`).join('');
}

function setLoading(container, loading) {
  container.classList.toggle('wf-loading', loading);
}

function setError(container, msg) {
  const badge = container.querySelector('.wf-status-badge');
  badge.className = 'wf-status-badge status-error';
  container.querySelector('.wf-status-icon').textContent = '✗';
  container.querySelector('.wf-status-text').textContent = 'Fehler';
  const table = container.querySelector('.wf-table');
  table.innerHTML = `<tr><td class="wf-label" colspan="2" style="color:var(--pink)">${msg}</td></tr>`;
}

// ── Section-Toggles ───────────────────────────────────────────────────────────

function toggleSection(name) {
  const section = document.getElementById(`section-${name}`);
  if (!section) return;
  const body  = section.querySelector(':scope > .section-body');
  const arrow = section.querySelector(':scope > .section-header .section-toggle');
  if (!body) return;
  const collapsed = body.classList.toggle('wf-collapsed');
  if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
}

function initSectionToggles() {
  ['allgemein', 'lv-pipeline', 'workflows', 'events', 'autopost', 'nachrichten', 'deploy-history'].forEach(name => {
    const hdr = document.getElementById(`hdr-${name}`);
    if (hdr) hdr.addEventListener('click', () => toggleSection(name));
  });
}

// ── Nav: Sektion aufklappen + scrollen ───────────────────────────────────────

function expandSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  const body  = section.querySelector(':scope > .section-body');
  const arrow = section.querySelector(':scope > .section-header .section-toggle');
  if (body && body.classList.contains('wf-collapsed')) {
    body.classList.remove('wf-collapsed');
    if (arrow) arrow.textContent = '▼';
  }
  // Übergeordnete Sektion auch aufklappen (Subsections in ALLGEMEIN)
  const parent = section.closest('.dash-section:not(.dash-subsection)');
  if (parent && parent !== section) {
    const pBody  = parent.querySelector(':scope > .section-body');
    const pArrow = parent.querySelector(':scope > .section-header .section-toggle');
    if (pBody && pBody.classList.contains('wf-collapsed')) {
      pBody.classList.remove('wf-collapsed');
      if (pArrow) pArrow.textContent = '▼';
    }
  }
}

// ── Badge-Count setzen (wird später von Workflows befüllt) ───────────────────

function setNavBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!count || count === 0) {
    el.textContent = '';
    el.style.display = 'none';
  } else {
    el.textContent = count > 99 ? '99+' : count;
    el.style.display = 'flex';
  }
}

function initNav() {
  // Username + Avatar-Initial setzen
  const session = getSession();
  const nameEl   = document.getElementById('dash-nav-username');
  const avatarEl = document.getElementById('dash-user-avatar');
  if (nameEl) nameEl.textContent = session?.username || 'nicht eingeloggt';
  if (avatarEl && session?.username) {
    avatarEl.textContent = session.username.substring(0, 2).toUpperCase();
  }

  // "Kommt bald"-Links sperren
  document.querySelectorAll('.dash-nav-soon').forEach(link => {
    link.addEventListener('click', e => e.preventDefault());
  });

  // Nav-Links: Sektion aufklappen und scrollen
  document.querySelectorAll('.dash-nav-item[data-nav]').forEach(link => {
    link.addEventListener('click', e => {
      if (link.classList.contains('dash-nav-ext')) return;
      e.preventDefault();
      const href = link.getAttribute('href');
      if (!href) return;

      // Sektion aufklappen
      const targetId = href.replace('#', '');
      const target = document.getElementById(targetId);
      if (target) {
        // Wenn es eine Subsektion ist, Section-ID ermitteln
        if (target.classList.contains('dash-section')) {
          expandSection(targetId);
        } else {
          // Karte in einer Sektion (z.B. wf-cookie-crawler) → ALLGEMEIN aufklappen
          expandSection('section-allgemein');
        }
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      }

      // Aktiven Nav-Item markieren
      document.querySelectorAll('.dash-nav-item').forEach(i => i.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Aktiven Abschnitt beim Scrollen markieren
  const navSections = [
    { id: 'section-events',       nav: 'events' },
    { id: 'section-autopost',     nav: 'autopost' },
    { id: 'section-nachrichten',  nav: 'nachrichten' },
    { id: 'section-lv-pipeline',  nav: 'lv-pipeline' },
    { id: 'section-workflows',    nav: 'workflows' },
    { id: 'wf-cookie-crawler',    nav: 'cookie' },
    { id: 'wf-joyclub-stats',     nav: 'stats' },
    { id: 'wf-server-metrics',    nav: 'server' },
  ];
  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY + 120;
    let active = null;
    navSections.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top + window.scrollY <= scrollY) active = id;
    });
    document.querySelectorAll('.dash-nav-item[data-nav]').forEach(link => {
      const sec = navSections.find(s => '#' + s.id === link.getAttribute('href'));
      link.classList.toggle('active', sec && '#' + sec.id === '#' + active);
    });
  }, { passive: true });
}

// ── Individuelle Karten-Toggles (statische Karten in ALLGEMEIN) ──────────────

function initCardToggles() {
  ['cookie-crawler', 'joyclub-login', 'server-metrics', 'joyclub-stats'].forEach(id => {
    const hdr  = document.getElementById(`hdr-card-${id}`);
    const card = document.getElementById(`wf-${id}`);
    if (!hdr || !card) return;
    hdr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const body  = card.querySelector('.wf-body');
      const arrow = hdr.querySelector('.wf-card-toggle');
      if (!body) return;
      const collapsed = body.classList.toggle('wf-collapsed');
      if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
    });
  });
}

// ── Workflows-Section Badge ───────────────────────────────────────────────────

function updateWorkflowsSectionBadge() {
  const ids = ['wf-cookie-crawler', 'wf-website-updates', 'wf-auto-posting', 'wf-joyclub-sync'];
  const priority = ['status-error', 'status-warn', 'status-unknown', 'status-ok'];
  const textMap = {
    'status-error':   ['✗', 'Fehler'],
    'status-warn':    ['⚠', 'Warnung'],
    'status-ok':      ['✓', 'Alle OK'],
    'status-unknown': ['◷', 'Lädt…'],
  };

  let worst = 'status-ok';
  for (const id of ids) {
    const card = document.getElementById(id);
    if (!card) continue;
    const badge = card.querySelector('.wf-status-badge');
    if (!badge) continue;
    for (const cls of priority) {
      if (badge.classList.contains(cls)) {
        if (priority.indexOf(cls) < priority.indexOf(worst)) worst = cls;
        break;
      }
    }
  }

  const sectionBadge = document.getElementById('section-workflows-badge');
  if (sectionBadge) {
    sectionBadge.className = `wf-status-badge ${worst}`;
    const [icon, text] = textMap[worst] || ['?', 'Unbekannt'];
    sectionBadge.querySelector('.wf-status-icon').textContent = icon;
    sectionBadge.querySelector('.wf-status-text').textContent = text;
  }
}

// ── Cookie-Lock: Sektionen sperren wenn kein JoyClub Login ──────────────────

const COOKIE_LOCKED_SECTIONS = [
  'section-events',
  'section-autopost',
  'section-nachrichten',
  'section-lv-pipeline',
  'section-workflows',
];

function applyCookieLockState() {
  const isLocked = window.f3CookieOk !== true;

  COOKIE_LOCKED_SECTIONS.forEach(id => {
    const section = document.getElementById(id);
    if (!section) return;
    const body = section.querySelector(':scope > .section-body');
    if (!body) return;

    if (isLocked) {
      section.classList.add('cookie-locked');
      if (!body.querySelector('.cookie-lock-banner')) {
        const banner = document.createElement('div');
        banner.className = 'cookie-lock-banner';
        banner.innerHTML =
          '<span class="cookie-lock-icon">🔒</span>' +
          '<span>JoyClub Login erforderlich – Cookies abgelaufen oder nicht vorhanden</span>' +
          '<button class="cookie-lock-login-btn" onclick="' +
            "document.getElementById('section-allgemein').scrollIntoView({behavior:'smooth'});" +
          '">Zum Login</button>';
        body.insertBefore(banner, body.firstChild);
      }
    } else {
      section.classList.remove('cookie-locked');
      body.querySelector('.cookie-lock-banner')?.remove();
    }
  });
}

// ── Workflow-Definitionen ─────────────────────────────────────────────────────

// Statische Karten in ALLGEMEIN (NocoDB / Webhook-Daten)
const WORKFLOWS = [
  { id: 'cookie-crawler',  fetch: fetchCookieStatus,        render: renderCookieCrawler   },
  { id: 'joyclub-login',   fetch: fetchJoyclubLoginStatus,  render: renderJoyclubLogin    },
  { id: 'server-metrics',  fetch: fetchServerMetrics,       render: renderServerMetrics   },
  { id: 'joyclub-stats',   fetch: fetchJoyclubStatsStatus,  render: renderJoyclubStats    },
];

// ── Refresh-Logic ─────────────────────────────────────────────────────────────

async function refreshWorkflow(wf) {
  const container = document.getElementById(`wf-${wf.id}`);
  if (!container) return;
  setLoading(container, true);
  try {
    const data = await wf.fetch();
    wf.render(container, data);
  } catch (err) {
    console.error(`[${wf.id}]`, err);
    setError(container, err.message);
  } finally {
    setLoading(container, false);
  }
}

async function refreshAutopost() {
  const container = document.getElementById('autopost-list');
  if (!container) return;
  try {
    const data = await fetchAutopostData();
    renderAutopost(container, data);
  } catch (err) {
    console.error('[autopost]', err);
    const badge = document.getElementById('section-autopost-badge');
    if (badge) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = 'Fehler';
    }
    container.innerHTML = `<p style="color:var(--pink);padding:8px 0">Fehler: ${err.message}</p>`;
  }
}

async function refreshEvents() {
  const container = document.getElementById('events-list');
  if (!container) return;
  try {
    const data = await fetchEventsData();
    renderEvents(container, data);
  } catch (err) {
    console.error('[events]', err);
    const badge = document.getElementById('section-events-badge');
    if (badge) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = 'Fehler';
    }
    if (container) {
      container.innerHTML = `<p style="color:var(--pink);padding:8px 0">Fehler: ${err.message}</p>`;
    }
  }
}

async function refreshNotifications() {
  const container = document.getElementById('notifications-container');
  if (!container) return;
  try {
    const data = await fetchNotificationsData();
    renderNotifications(container, data);
  } catch (err) {
    console.error('[notifications]', err);
    const badge = document.getElementById('section-nachrichten-badge');
    if (badge) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = 'Fehler';
    }
    const list = container.querySelector('.notif-list');
    if (list) list.innerHTML = `<p class="notif-empty" style="color:var(--pink)">Fehler: ${err.message}</p>`;
  }
}

async function refreshDynamicWorkflows() {
  const container = document.getElementById('workflows-dynamic');
  if (!container) return;
  try {
    const data = await fetchDynamicWorkflowsData();
    renderDynamicWorkflows(container, data);
  } catch (err) {
    console.error('[workflows-dynamic]', err);
    const badge = document.getElementById('section-workflows-badge');
    if (badge) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = 'API Fehler';
    }
    if (container) container.innerHTML = '<p style="color:var(--pink);padding:8px 0">Fehler: ' + err.message + '</p>';
  }
}

async function refreshLVPipeline() {
  const container = document.getElementById('lv-pipeline-container');
  if (!container) return;
  try {
    const steps = await fetchLVPipelineData();
    renderLVPipelineSection(container, steps);
  } catch (err) {
    console.error('[lv-pipeline]', err);
    container.innerHTML = '<p style="color:var(--pink);padding:8px 0">Fehler: ' + err.message + '</p>';
  }
  // Kandidaten separat (eigener Error-Handler, eigene Ladezeit)
  const candContainer = document.getElementById('lv-candidates-container');
  if (candContainer) {
    try {
      const result = await fetchLVCandidates();
      renderLVCandidates(candContainer, result);
    } catch (err) {
      console.warn('[lv-candidates]', err);
      candContainer.innerHTML = '<p class="lv-cand-empty">Kandidaten nicht verfügbar: ' + err.message + '</p>';
    }
  }
}

async function refreshAll() {
  updateLastRefresh();
  clearWorkflowCache(); // frische Daten pro Zyklus
  await Promise.allSettled([
    ...WORKFLOWS.map(refreshWorkflow),
    refreshLVPipeline(),
    refreshEvents(),
    refreshAutopost(),
    refreshNotifications(),
    refreshDynamicWorkflows(),
  ]);
  applyCookieLockState();
}

function updateLastRefresh() {
  const el = document.getElementById('last-refresh');
  if (el) el.textContent = new Date().toLocaleTimeString('de-DE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function startCountdown() {
  const el = document.getElementById('next-refresh');
  let secs = CONFIG.refreshInterval / 1000;
  if (el) el.textContent = secs;
  const id = setInterval(() => {
    secs--;
    if (el) el.textContent = secs;
    if (secs <= 0) {
      clearInterval(id);
      refreshAll().then(startCountdown);
    }
  }, 1000);
}

// ── Login ─────────────────────────────────────────────────────────────────────

function getSession() {
  try { return JSON.parse(sessionStorage.getItem('f3_session') || 'null'); } catch { return null; }
}

function setSession(username, password) {
  sessionStorage.setItem('f3_session', JSON.stringify({ username, password }));
}

function initLogin() {
  const overlay = document.getElementById('login-overlay');
  const form    = document.getElementById('login-form');
  const btn     = document.getElementById('login-btn');
  const error   = document.getElementById('login-error');

  if (getSession()) { overlay.classList.add('hidden'); return; }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) {
      error.textContent = 'Bitte Name und Passwort eingeben.';
      return;
    }
    setSession(username, password);
    // Username + Avatar in Nav aktualisieren
    const nameEl   = document.getElementById('dash-nav-username');
    const avatarEl = document.getElementById('dash-user-avatar');
    if (nameEl)   nameEl.textContent   = username;
    if (avatarEl) avatarEl.textContent = username.substring(0, 2).toUpperCase();
    overlay.classList.add('hidden');
    refreshAll().then(startCountdown);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initVersion() {
  const el = document.getElementById('dash-version');
  if (!el) return;
  const v = CONFIG?.version;
  if (v && v !== 'unknown') {
    el.textContent = v.substring(0, 7);
    el.title = 'Deployter Commit: ' + v + ' – klicken für GitHub';
    el.href = 'https://github.com/kuschel190190-ai/f3-cookie-crawler-/commit/' + v;
  } else {
    el.textContent = 'dev';
    el.title = 'Lokale Entwicklungsversion';
    el.removeAttribute('href');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-refresh')?.addEventListener('click', refreshAll);
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    sessionStorage.removeItem('f3_session');
    location.reload();
  });
  initVersion();
  initSectionToggles();
  initCardToggles();
  initNav();
  initLogin();
  refreshDeployHistory(); // einmalig, nicht im 60s-Cycle
  if (getSession()) refreshAll().then(startCountdown);
});
