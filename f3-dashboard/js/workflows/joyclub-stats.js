// Workflow-Karte: JoyClub Stats (live via Stats API)

async function fetchJoyclubStatsStatus() {
  const res = await fetch('https://n8n.f3-events.de/webhook/f3-stats-api', {
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`Stats API ${res.status}`);
  const s = await res.json();

  const fmt = n => (n != null) ? n.toLocaleString('de-DE') : '—';
  const updatedAt = s.updatedAt ? new Date(s.updatedAt) : null;

  return {
    statusClass: (s.fans != null) ? 'status-ok' : 'status-error',
    statusText:  (s.fans != null) ? 'Aktuell'   : 'Fehler',
    statusIcon:  (s.fans != null) ? '✓'          : '✗',
    rows: [
      { label: 'Fans',           value: fmt(s.fans) },
      { label: 'Profilbesucher', value: fmt(s.besucher) },
      { label: 'Bewertungen',    value: fmt(s.bewertungen) },
      { label: 'Ø Bewertung',    value: s.rating != null ? `${s.rating.toFixed(1).replace('.', ',')} / 5` : '—' },
      { label: 'Abgerufen',      value: updatedAt ? formatDateTime(updatedAt) : '—' },
    ]
  };
}

function renderJoyclubStats(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);
}
