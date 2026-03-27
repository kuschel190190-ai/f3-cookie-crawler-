// F3 Dashboard – Dynamische Workflow-Karten aus n8n API

async function fetchAllWorkflows() {
  const res = await fetch(CONFIG.n8n.baseUrl + '/api/v1/workflows?limit=100&active=true', {
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

function renderDynamicCard(wf) {
  const lastExec  = wf.executions[0];
  const successes = wf.executions.filter(e => e.status === 'success').length;
  const total     = wf.executions.length;

  // Status berechnen
  let cls  = 'status-unknown';
  let icon = '◷';
  let text = 'Keine Ausführung';

  if (lastExec) {
    if (lastExec.status === 'success') { cls = 'status-ok';    icon = '✓'; text = 'OK';     }
    else if (lastExec.status === 'error')   { cls = 'status-error'; icon = '✗'; text = 'Fehler'; }
    else                                    { cls = 'status-warn';  icon = '⚠'; text = lastExec.status; }
  } else if (wf.active) {
    cls = 'status-ok'; icon = '✓'; text = 'Aktiv';
  }

  // Zeiten formatieren
  const lastRun = lastExec?.startedAt
    ? new Date(lastExec.startedAt).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      })
    : '—';

  const duration = (lastExec?.stoppedAt && lastExec?.startedAt)
    ? Math.round((new Date(lastExec.stoppedAt) - new Date(lastExec.startedAt)) / 1000) + 's'
    : '—';

  const rate = total > 0 ? successes + '/' + total : '—';

  return '<div class="wf-card">'
    + '<div class="wf-header wf-toggle">'
    +   '<span class="wf-card-toggle">▼</span>'
    +   '<div class="wf-title-group">'
    +     '<span class="wf-icon">' + (wf.active ? '⚡' : '⏸') + '</span>'
    +     '<a class="wf-title wf-title-link" href="' + CONFIG.n8n.baseUrl + '/workflow/' + wf.id + '" target="_blank" rel="noopener">' + wf.name + '</a>'
    +   '</div>'
    +   '<div class="wf-status-badge ' + cls + '">'
    +     '<span class="wf-status-icon">' + icon + '</span>'
    +     '<span class="wf-status-text">' + text + '</span>'
    +   '</div>'
    + '</div>'
    + '<div class="wf-body">'
    +   '<div class="wf-divider"></div>'
    +   '<table class="wf-table">'
    +     '<tr><td class="wf-label">Letzte Ausführung</td><td class="wf-value">' + lastRun + '</td></tr>'
    +     '<tr><td class="wf-label">Dauer</td><td class="wf-value">' + duration + '</td></tr>'
    +     '<tr><td class="wf-label">Erfolge (letzte 3)</td><td class="wf-value">' + rate + '</td></tr>'
    +   '</table>'
    + '</div>'
    + '</div>';
}
