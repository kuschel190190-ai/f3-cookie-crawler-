// F3 Dashboard – Dynamische Workflow-Karten aus n8n API

async function fetchAllWorkflows() {
  const res = await fetch(CONFIG.n8n.baseUrl + '/api/v1/workflows?limit=100', {
    headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey }
  });
  if (!res.ok) throw new Error('n8n API ' + res.status);
  const data = await res.json();
  return (data.data || []).filter(wf => wf.name.startsWith('F3'));
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

async function fetchDynamicWorkflowsData() {
  const workflows = await fetchAllWorkflows();

  const withExecs = await Promise.all(workflows.map(async wf => {
    const execs = await fetchWorkflowExecutions(wf.id);
    return { ...wf, executions: execs };
  }));

  // Sortieren: Fehler zuerst, dann nach Name
  withExecs.sort((a, b) => {
    const aErr = a.executions[0]?.status === 'error' ? 0 : 1;
    const bErr = b.executions[0]?.status === 'error' ? 0 : 1;
    if (aErr !== bErr) return aErr - bErr;
    return a.name.localeCompare(b.name);
  });

  return withExecs;
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
      if (e.target.closest('a')) return;
      const card  = hdr.closest('.wf-card');
      const body  = card?.querySelector('.wf-body');
      const arrow = hdr.querySelector('.wf-card-toggle');
      if (!body) return;
      const collapsed = body.classList.toggle('wf-collapsed');
      if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
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
  { match: 'autopost',       source: 'NocoDB',          login: false },
  { match: 'cookie',         source: 'NocoDB',          login: true  },
  { match: 'joyclub-sync',   source: 'JoyClub',         login: true  },
  { match: 'joyclub sync',   source: 'JoyClub',         login: true  },
  { match: 'sync',           source: 'JoyClub',         login: true  },
  { match: 'stats',          source: 'JoyClub',         login: false },
  { match: 'events api',     source: 'NocoDB',          login: false },
  { match: 'website',        source: 'NocoDB',          login: false },
  { match: 'benachrichtig',  source: 'JoyClub',         login: true  },
  { match: 'ladies',         source: 'NocoDB + JoyClub',login: true  },
  { match: 'voting',         source: 'NocoDB + JoyClub',login: true  },
];

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

  return '<div class="wf-card' + (hasError ? ' has-error' : '') + (isInactive ? ' wf-inactive' : '') + '">'
    + '<div class="wf-header wf-toggle">'
    +   '<span class="wf-card-toggle">▼</span>'
    +   '<div class="wf-title-group">'
    +     activeIcon
    +     '<a class="wf-title wf-title-link" href="https://n8n.f3-events.de/workflow/' + wf.id + '" target="_blank" rel="noopener">' + wf.name + '</a>'
    +     loginBadge
    +     sourceBadge
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
