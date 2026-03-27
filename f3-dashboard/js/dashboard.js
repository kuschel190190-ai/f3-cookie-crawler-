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
  const body = section.querySelector(':scope > .section-body');
  const arrow = section.querySelector(':scope > .section-header .section-toggle');
  if (!body) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  if (arrow) arrow.textContent = isHidden ? '▼' : '▶';
}

function initSectionToggles() {
  ['allgemein', 'workflows', 'events'].forEach(name => {
    const hdr = document.getElementById(`hdr-${name}`);
    if (hdr) hdr.addEventListener('click', () => toggleSection(name));
  });
}

// ── Individuelle Karten-Toggles (statische Karten in ALLGEMEIN) ──────────────

function initCardToggles() {
  ['cookie-crawler', 'joyclub-stats', 'ladies-voting'].forEach(id => {
    const hdr  = document.getElementById(`hdr-card-${id}`);
    const card = document.getElementById(`wf-${id}`);
    if (!hdr || !card) return;
    hdr.addEventListener('click', () => {
      const body  = card.querySelector('.wf-body');
      const arrow = hdr.querySelector('.wf-card-toggle');
      if (!body) return;
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? '' : 'none';
      if (arrow) arrow.textContent = isHidden ? '▼' : '▶';
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

// ── Workflow-Definitionen ─────────────────────────────────────────────────────

// Statische Karten in ALLGEMEIN (NocoDB / Webhook-Daten)
const WORKFLOWS = [
  { id: 'cookie-crawler', fetch: fetchCookieStatus,       render: renderCookieCrawler },
  { id: 'joyclub-stats',  fetch: fetchJoyclubStatsStatus, render: renderJoyclubStats  },
  { id: 'ladies-voting',  fetch: fetchLadiesVotingStatus, render: renderLadiesVoting  },
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

async function refreshAll() {
  updateLastRefresh();
  await Promise.allSettled([
    ...WORKFLOWS.map(refreshWorkflow),
    refreshEvents(),
    refreshDynamicWorkflows(),
  ]);
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

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-refresh')?.addEventListener('click', refreshAll);
  initSectionToggles();
  initCardToggles();
  refreshAll().then(startCountdown);
});
