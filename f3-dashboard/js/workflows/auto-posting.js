// Workflow-Karte: Automatisches Posten
// Zeigt letzten autopost-v4 Lauf + nächsten geplanten Post

async function fetchAutoPostStatus() {
  const { baseUrl, apiKey, workflows } = CONFIG.n8n;

  // Letzte 3 Ausführungen holen (für Erfolgsrate)
  const url = `${baseUrl}/api/v1/executions?workflowId=${workflows.autopost}&limit=3&includeData=false`;
  const res = await fetch(url, { headers: { 'X-N8N-API-KEY': apiKey } });
  if (!res.ok) throw new Error(`n8n ${res.status}`);
  const data = await res.json();
  const executions = data.data ?? [];
  const last = executions[0];

  const lastRun = last?.startedAt ? new Date(last.startedAt) : null;
  const success = last?.status === 'success';

  // Nächster Post: Mo-Fr 06:00 Uhr
  const nextPost = getNextWeekdayAt6();

  // Erfolgsrate der letzten 3 Läufe
  const successCount = executions.filter(e => e.status === 'success').length;
  const rate = executions.length > 0 ? `${successCount}/${executions.length}` : '—';

  return {
    statusClass: last ? (success ? 'status-ok' : 'status-error') : 'status-unknown',
    statusText: last ? (success ? 'Gepostet' : 'Fehler') : 'Kein Post',
    statusIcon: last ? (success ? '✓' : '✗') : '?',
    rows: [
      { label: 'Letzter Post', value: lastRun ? formatDateTime(lastRun) : '—' },
      { label: 'Status', value: last?.status ?? '—' },
      { label: 'Erfolge (letzte 3)', value: rate },
      { label: 'Nächster Post', value: nextPost },
    ]
  };
}

function getNextWeekdayAt6() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  // Überspringe Wochenende
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' 06:00';
}

function renderAutoPosting(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);
}
