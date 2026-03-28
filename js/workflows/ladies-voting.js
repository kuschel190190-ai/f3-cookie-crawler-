// Workflow-Karte: Ladies Voting
// Live-Status via n8n Webhook – zeigt ob heute Voting-Tag (Donnerstag) ist

async function fetchLadiesVotingStatus() {
  const res = await fetch('https://n8n.f3-events.de/webhook/f3-ladies-voting-api', {
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`Ladies Voting API ${res.status}`);
  const d = await res.json();

  const today = d.isVotingDay;
  return {
    statusClass: today ? 'status-ok' : 'status-warn',
    statusText:  today ? 'Voting heute!' : `In ${d.daysUntil} Tag${d.daysUntil === 1 ? '' : 'en'}`,
    statusIcon:  today ? '✓' : '◷',
    rows: [
      { label: 'Nächstes Voting', value: d.nextVotingDate || '—' },
      { label: 'Zuletzt sync.',   value: d.lastSyncAt    || '—' },
    ]
  };
}

function renderLadiesVoting(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);
}
