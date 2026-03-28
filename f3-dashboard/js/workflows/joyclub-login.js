// Workflow-Karte: JoyClub Login Status
// Zeigt ob Session aktiv ist + Button zum manuellen Login via CDP

async function fetchJoyclubLoginStatus() {
  const { baseUrl, apiToken, projectId, tables } = CONFIG.nocodb;
  const url = `${baseUrl}/api/v1/db/data/noco/${projectId}/${tables.cookies}?limit=1`;

  const res = await fetch(url, { headers: { 'xc-token': apiToken } });
  if (!res.ok) throw new Error(`NocoDB ${res.status}`);
  const data = await res.json();
  const record = data.list?.[0];
  if (!record) throw new Error('Keine Cookie-Einträge gefunden');

  const updatedAt = record['UpdatedAt'] ? new Date(record['UpdatedAt']) : null;
  const now = new Date();
  const ageH = updatedAt ? Math.floor((now - updatedAt) / 3_600_000) : null;

  let statusClass, statusIcon, statusText;
  if (ageH === null) {
    statusClass = 'status-unknown'; statusIcon = '?'; statusText = 'Unbekannt';
  } else if (ageH < 6) {
    statusClass = 'status-ok';   statusIcon = '✓'; statusText = 'Session aktiv';
  } else if (ageH < 24) {
    statusClass = 'status-warn'; statusIcon = '⚠'; statusText = `Vor ${ageH}h sync.`;
  } else {
    statusClass = 'status-error'; statusIcon = '✗'; statusText = 'Session abgelaufen';
  }

  const updatedText = updatedAt
    ? updatedAt.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

  return {
    statusClass, statusIcon, statusText,
    rows: [
      { label: 'Letzter Sync', value: updatedText },
      { label: 'Alter',        value: ageH !== null ? `${ageH}h` : '—' },
      { label: 'Account',      value: record['Name'] || '—' },
    ]
  };
}

async function triggerLogin(btn) {
  btn.disabled = true;
  btn.textContent = '⏳ Läuft…';
  try {
    const res = await fetch(CONFIG.webhooks.autoLogin, {
      method: 'POST',
      signal: AbortSignal.timeout(55000)
    });
    const d = await res.json();
    btn.textContent = d.success ? '✓ Eingeloggt!' : '✗ Fehlgeschlagen';
    btn.style.background = d.success ? 'var(--green, #4caf50)' : 'var(--pink)';
    setTimeout(() => { btn.textContent = '🔐 Login auslösen'; btn.disabled = false; btn.style.background = ''; }, 4000);
  } catch(e) {
    btn.textContent = '✗ Timeout/Fehler';
    btn.style.background = 'var(--pink)';
    setTimeout(() => { btn.textContent = '🔐 Login auslösen'; btn.disabled = false; btn.style.background = ''; }, 4000);
  }
}

function renderJoyclubLogin(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);

  const btn = container.querySelector('.btn-login');
  if (btn && !btn._bound) {
    btn._bound = true;
    btn.addEventListener('click', () => triggerLogin(btn));
  }
}
