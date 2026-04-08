// Workflow-Karte: Website + Aktualisierungen
// Zeigt letzten joyclub-sync Lauf + Anzahl aktiver Events in NocoDB

async function fetchWebsiteStatus() {
  const { baseUrl: n8nBase, apiKey, workflows } = CONFIG.n8n;

  // Letzter joyclub-sync Lauf via n8n API
  const exUrl = `${n8nBase}/api/v1/executions?workflowId=${workflows.joyclubSync}&limit=1&includeData=false`;
  const exRes = await fetch(exUrl, { headers: { 'X-N8N-API-KEY': apiKey } });
  if (!exRes.ok) throw new Error(`n8n ${exRes.status}`);
  const exData = await exRes.json();
  const lastEx = exData.data?.[0];

  // Aktive Events aus SQLite
  const evRes = await fetch('/api/events?status=aktiv&limit=1');
  if (!evRes.ok) throw new Error(`API ${evRes.status}`);
  const evData = await evRes.json();
  const activeCount = evData.pageInfo?.totalRows ?? '—';

  const lastRun = lastEx?.startedAt ? new Date(lastEx.startedAt) : null;
  const success = lastEx?.status === 'success';

  // Nächster Sync: alle 4 Stunden ab letztem Lauf
  let nextRun = '—';
  if (lastRun) {
    const next = new Date(lastRun.getTime() + 4 * 3_600_000);
    nextRun = next.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  return {
    statusClass: lastEx ? (success ? 'status-ok' : 'status-error') : 'status-unknown',
    statusText: lastEx ? (success ? 'Sync OK' : 'Fehler') : 'Kein Lauf',
    statusIcon: lastEx ? (success ? '✓' : '✗') : '?',
    rows: [
      { label: 'Letzter Sync', value: lastRun ? formatDateTime(lastRun) : '—' },
      { label: 'Dauer', value: lastEx?.stoppedAt ? `${Math.round((new Date(lastEx.stoppedAt) - new Date(lastEx.startedAt)) / 1000)}s` : '—' },
      { label: 'Aktive Events', value: String(activeCount) },
      { label: 'Nächster Sync', value: nextRun },
    ]
  };
}

function renderWebsiteUpdates(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);
}
