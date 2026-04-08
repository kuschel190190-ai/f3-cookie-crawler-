// Ladies Voting Pipeline – Bauplan-Ansicht (Lv 0–5) + Kandidaten-Liste
// Nutzt fetchWorkflowExecutions() + relativeTime() aus dynamic.js

const LV_STEPS = [
  {
    lv: 0,
    n8nId: null,
    name: 'Auto-Login',
    icon: '🔐',
    desc: 'JOYclub automatisch einloggen',
    planned: false,
    manual: true,       // kein n8n-Trigger, direkter CDP-Login
    uses: [],
    n8nLink: null,
  },
  {
    lv: 1,
    n8nId: 'fgHKrok4oZYaYBry',
    name: 'Cookie Crawler',
    icon: '🍪',
    desc: 'Session-Cookie aktiv halten',
    planned: false,
    uses: [],
    provides: true,
    n8nLink: 'https://n8n.f3-events.de/workflow/fgHKrok4oZYaYBry',
  },
  {
    lv: 2,
    n8nId: 'v2podBSp75cdxZeH',
    name: 'Benach\u00adrichtigungen',
    icon: '📬',
    desc: 'Neue Anmeldungen erkennen',
    planned: false,
    uses: ['cookie'],
    n8nLink: 'https://n8n.f3-events.de/workflow/v2podBSp75cdxZeH',
  },
  {
    lv: 3,
    n8nId: 'pcqVgwCQlLC8JhdS',
    name: 'Profil-Scraper',
    icon: '🔍',
    desc: 'Fotos + Profildaten laden',
    planned: false,
    uses: ['cookie'],
    n8nLink: 'https://n8n.f3-events.de/workflow/pcqVgwCQlLC8JhdS',
  },
  {
    lv: 4,
    n8nId: 'WftVmeL20Kgu2d9y',
    name: 'Telegram-Sender',
    icon: '✈️',
    desc: 'Kandidaten an Voting-Gruppe',
    planned: false,
    uses: [],
    n8nLink: 'https://n8n.f3-events.de/workflow/WftVmeL20Kgu2d9y',
  },
  {
    lv: 5,
    n8nId: 'JVfVCBdfj7VH3Bbh',
    name: 'Status-API',
    icon: '📊',
    desc: 'Dashboard-Status Webhook',
    planned: false,
    uses: [],
    n8nLink: 'https://n8n.f3-events.de/workflow/JVfVCBdfj7VH3Bbh',
  },
];

async function fetchLVPipelineData() {
  const results = await Promise.all(LV_STEPS.map(async step => {
    if (step.manual) {
      return { ...step, execStatus: 'manual', executions: [], lastAt: null, duration: '—' };
    }
    if (step.planned || !step.n8nId) {
      return { ...step, execStatus: 'planned', executions: [], lastAt: null, duration: '—' };
    }
    try {
      const execs = await fetchWorkflowExecutions(step.n8nId);
      const last = execs[0];
      const dur = (last?.stoppedAt && last?.startedAt)
        ? Math.round((new Date(last.stoppedAt) - new Date(last.startedAt)) / 1000) + ' s'
        : '—';
      return {
        ...step,
        execStatus: last ? last.status : 'no-exec',
        executions: execs,
        lastAt: last?.startedAt || null,
        duration: dur,
      };
    } catch {
      return { ...step, execStatus: 'fetch-error', executions: [], lastAt: null, duration: '—' };
    }
  }));
  return results;
}

function renderLVPipelineSection(container, steps) {
  // Section badge
  const badge = document.getElementById('section-lv-pipeline-badge');
  if (badge) {
    const active = steps.filter(s => !s.planned);
    const hasError = active.some(s => s.execStatus === 'error' || s.execStatus === 'fetch-error');
    const allOk    = active.every(s => ['success', 'no-exec', 'manual'].includes(s.execStatus));
    if (hasError) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = 'Fehler';
    } else if (allOk) {
      badge.className = 'wf-status-badge status-ok';
      badge.querySelector('.wf-status-icon').textContent = '✓';
      badge.querySelector('.wf-status-text').textContent = 'Pipeline OK';
    } else {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '⚠';
      badge.querySelector('.wf-status-text').textContent = 'Warnung';
    }
  }

  container.innerHTML =
    '<div class="lv-pipeline">' +
      steps.map((step, i) => renderLVStep(step) + (i < steps.length - 1 ? '<div class="lv-arrow">▶</div>' : '')).join('') +
    '</div>' +
    '<div class="lv-dep-note">🍪 <strong>Cookie Crawler (Lv 1)</strong> wird genutzt von: Lv 2 · Lv 3 — stellt den JOYclub Session-Cookie für alle HTTP-Requests bereit</div>' +
    '<div id="lv-candidates-container" class="lv-candidates-wrap"><span style="color:var(--muted);font-size:0.8rem">Lädt Kandidaten…</span></div>';

  // Error log toggles
  container.querySelectorAll('.lv-log-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const log = btn.nextElementSibling;
      if (!log || !log.classList.contains('lv-step-log')) return;
      const collapsed = log.classList.toggle('wf-collapsed');
      btn.textContent = collapsed ? '▼ Fehlerlog' : '▲ Fehlerlog';
    });
  });
}

function lvStepStatus(step) {
  if (step.manual)  return { cls: 'status-ok',      icon: '✓', text: 'Bereit' };
  if (step.planned) return { cls: 'status-unknown', icon: '◷', text: 'Geplant' };
  switch (step.execStatus) {
    case 'success':     return { cls: 'status-ok',    icon: '✓', text: 'OK' };
    case 'no-exec':     return { cls: 'status-ok',    icon: '✓', text: 'Aktiv' };
    case 'error':       return { cls: 'status-error', icon: '✗', text: 'Fehler' };
    case 'fetch-error': return { cls: 'status-error', icon: '✗', text: 'API Fehler' };
    default:            return { cls: 'status-warn',  icon: '⚠', text: step.execStatus };
  }
}

function renderLVStep(step) {
  const { cls, icon, text } = lvStepStatus(step);
  const hasErr = step.executions && step.executions.some(e => e.status === 'error');
  const errorExecs = hasErr ? step.executions.filter(e => e.status === 'error') : [];

  const linkHtml = step.n8nLink
    ? '<a class="lv-step-link" href="' + step.n8nLink + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">n8n öffnen →</a>'
    : '<span class="lv-planned-tag">In Planung</span>';

  const depHtml = step.uses.includes('cookie')
    ? '<span class="lv-dep-badge">🍪 Cookie</span><span class="wf-login-badge" title="JoyClub Login erforderlich">🔐</span>'
    : '';

  const metaHtml = step.planned
    ? '<div class="lv-step-meta"><span class="lv-step-time">noch nicht gebaut</span></div>'
    : step.manual
    ? '<div class="lv-step-meta"><span class="lv-step-time">manuell auslösen</span>' + depHtml + '</div>'
    : '<div class="lv-step-meta"><span class="lv-step-time">' + relativeTime(step.lastAt) + '</span>' + depHtml + '</div>';

  const logHtml = hasErr
    ? '<button class="lv-log-toggle">▲ Fehlerlog</button>'
      + '<div class="lv-step-log">'
      + errorExecs.map(e =>
          '<div class="lv-log-entry">✗ ' + relativeTime(e.startedAt)
          + (e.id ? ' <a class="lv-log-link" href="https://n8n.f3-events.de/executions/' + e.id + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Details →</a>' : '')
          + '</div>'
        ).join('')
      + '</div>'
    : '';

  // LV 0: kein eigener Button – Login läuft über JoyClub Login Karte (ALLGEMEIN)
  const loginHtml = '';

  return '<div class="lv-step' + (step.planned ? ' lv-step-planned' : '') + (step.execStatus === 'error' ? ' has-error' : '') + '">'
    + '<span class="lv-step-lv">LV ' + step.lv + '</span>'
    + '<span class="lv-step-icon">' + step.icon + '</span>'
    + '<span class="lv-step-name">' + step.name + '</span>'
    + '<div class="wf-status-badge ' + cls + '"><span class="wf-status-icon">' + icon + '</span><span class="wf-status-text">' + text + '</span></div>'
    + '<span class="lv-step-desc">' + step.desc + '</span>'
    + metaHtml
    + loginHtml
    + linkHtml
    + logHtml
    + '</div>';
}

// ── Kandidaten aus NocoDB ─────────────────────────────────────────────────────

async function fetchLVCandidates() {
  const res = await fetch('/api/ladies-voting?limit=100', {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('API LV ' + res.status);
  return res.json();
}

const LV_STATUS_CFG = {
  neu:           { cls: 'lv-cand-status--neu',     label: 'neu' },
  fotos_geladen: { cls: 'lv-cand-status--fotos',   label: 'Fotos ✓' },
  gesendet:      { cls: 'lv-cand-status--gesendet', label: 'gesendet ✈' },
  fehler:        { cls: 'lv-cand-status--fehler',   label: 'Fehler ✗' },
};

function renderLVCandidates(container, result) {
  const candidates = result?.list || [];

  if (candidates.length === 0) {
    container.innerHTML = '<p class="lv-cand-empty">Keine Kandidaten in NocoDB</p>';
    return;
  }

  // Status-Zusammenfassung
  const counts = {};
  for (const c of candidates) {
    const s = c.Status || 'neu';
    counts[s] = (counts[s] || 0) + 1;
  }
  const summaryHtml = Object.entries(counts).map(([s, n]) => {
    const cfg = LV_STATUS_CFG[s] || LV_STATUS_CFG.neu;
    return '<span class="lv-cand-summary-badge ' + cfg.cls + '">' + n + ' ' + cfg.label + '</span>';
  }).join('');

  const cardsHtml = candidates.map(c => {
    let photos = [];
    try { photos = JSON.parse(c.Fotos || '[]'); } catch {}
    const thumb = photos[0] || '';
    const cfg = LV_STATUS_CFG[c.Status] || LV_STATUS_CFG.neu;
    const meta = [c.Alter ? c.Alter + ' J.' : '', c.Stadt].filter(Boolean).join(' · ');
    const thumbHtml = thumb
      ? '<div class="lv-cand-thumb"><img src="' + thumb + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'👤\'"></div>'
      : '<div class="lv-cand-thumb lv-cand-thumb--empty">👤</div>';

    return '<div class="lv-cand-card">'
      + thumbHtml
      + '<div class="lv-cand-info">'
      +   '<a class="lv-cand-name" href="' + (c.ProfilUrl || '#') + '" target="_blank" rel="noopener">' + (c.Username || '—') + '</a>'
      +   (meta ? '<span class="lv-cand-meta">' + meta + '</span>' : '')
      +   '<span class="lv-cand-status ' + cfg.cls + '">' + cfg.label + '</span>'
      + '</div>'
      + '</div>';
  }).join('');

  container.innerHTML =
    '<div class="lv-candidates-header">'
    +   '<span class="lv-candidates-title">👩 Kandidaten (' + candidates.length + ')</span>'
    +   '<div class="lv-candidates-summary">' + summaryHtml + '</div>'
    + '</div>'
    + '<div class="lv-candidates-grid">' + cardsHtml + '</div>';
}
