// Workflow-Karte: Ladies Voting
// Platzhalter – wird nach Screenshots von Tobias implementiert

async function fetchLadiesVotingStatus() {
  // TODO: Nach Screenshots implementieren
  // Mögliche Quellen:
  // - NocoDB Tabelle für Voting-Kandidatinnen
  // - n8n Workflow für Voting-Posts
  // - JoyClub Voting-Seite scrapen

  return {
    statusClass: 'status-unknown',
    statusText: 'In Planung',
    statusIcon: '◷',
    rows: [
      { label: 'Status', value: 'Wird konfiguriert' },
      { label: 'Info', value: 'Screenshots ausstehend' },
    ],
    placeholder: true,
  };
}

function renderLadiesVoting(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);

  if (data.placeholder) {
    const body = container.querySelector('.wf-body');
    const note = document.createElement('p');
    note.className = 'wf-placeholder-note';
    note.textContent = 'Schick Tobias die Screenshots, dann wird diese Karte gebaut.';
    if (!body.querySelector('.wf-placeholder-note')) body.appendChild(note);
  }
}
