// Workflow-Karte: JoyClub Login Status
// Einzige Login-Stelle im Dashboard – Button aktiv nur wenn Session abgelaufen

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

  let statusClass, statusIcon, statusText, sessionActive;
  if (ageH === null) {
    statusClass = 'status-unknown'; statusIcon = '?'; statusText = 'Unbekannt'; sessionActive = false;
  } else if (ageH < 6) {
    statusClass = 'status-ok';    statusIcon = '✓'; statusText = 'Session aktiv'; sessionActive = true;
  } else if (ageH < 24) {
    statusClass = 'status-warn';  statusIcon = '⚠'; statusText = `Vor ${ageH}h sync.`; sessionActive = false;
  } else {
    statusClass = 'status-error'; statusIcon = '✗'; statusText = 'Session abgelaufen'; sessionActive = false;
  }

  const updatedText = updatedAt
    ? updatedAt.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

  return {
    statusClass, statusIcon, statusText, sessionActive,
    rows: [
      { label: 'Letzter Sync', value: updatedText },
      { label: 'Alter',        value: ageH !== null ? `${ageH}h` : '—' },
      { label: 'Account',      value: record['Name'] || '—' },
    ]
  };
}

async function triggerLogin(btn, sessionActive) {
  if (sessionActive) return; // Sicherheits-Guard
  btn.disabled = true;
  btn.textContent = '⏳ Läuft (~30s)…';
  try {
    const session = getSession();
    const res = await fetch('/proxy/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: session?.username, password: session?.password }),
      signal: AbortSignal.timeout(65000)
    });
    const d = await res.json();
    if (d.success) {
      btn.textContent = '🔓 Eingeloggt!';
      btn.style.color = 'var(--ok, #4caf50)';
      btn.style.borderColor = 'var(--ok, #4caf50)';
      // Cookie-Sync Workflow triggern
      fetch('/proxy/n8n/api/v1/workflows/fgHKrok4oZYaYBry/run', {
        method: 'POST',
        headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }).catch(() => {});
    } else {
      throw new Error(d.error || 'Login fehlgeschlagen');
    }
  } catch(e) {
    btn.textContent = '🔒 Fehler – erneut versuchen';
    btn.style.color = 'var(--pink)';
    btn.style.borderColor = 'var(--pink)';
    btn.disabled = false;
  }
}

function renderJoyclubLogin(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);

  const btn = container.querySelector('.btn-login');
  if (!btn) return;

  // Zustand je nach Session
  if (data.sessionActive) {
    btn.textContent = '🔓 Session aktiv';
    btn.disabled = true;
    btn.style.opacity = '0.45';
    btn.style.cursor = 'not-allowed';
    btn.style.color = '';
    btn.style.borderColor = '';
    btn._bound = false; // Reset damit bei nächstem Refresh neu gebunden
  } else {
    btn.textContent = '🔒 Jetzt einloggen';
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.style.color = '';
    btn.style.borderColor = '';
    if (!btn._bound) {
      btn._bound = true;
      btn.addEventListener('click', () => triggerLogin(btn, data.sessionActive));
    }
  }
}
