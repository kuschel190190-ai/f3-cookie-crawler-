// Workflow-Karte: JoyClub Login Status
// Einzige Login-Stelle im Dashboard – Button aktiv nur wenn Session abgelaufen

async function fetchJoyclubLoginStatus() {
  // Cookie + Live-Session-Check parallel
  const [res, sessionRes] = await Promise.all([
    fetch('/api/cookies', { signal: AbortSignal.timeout(8000) }),
    fetch('/proxy/session-check', { signal: AbortSignal.timeout(8000) }).catch(() => null)
  ]);
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const record = data.list?.[0];
  if (!record) throw new Error('Keine Cookie-Einträge gefunden');

  // Live-Status aus Chromium (null = Chromium nicht erreichbar → ignorieren)
  const sessionCheck = sessionRes?.ok ? await sessionRes.json().catch(() => null) : null;
  const chromiumLoggedIn = sessionCheck?.loggedIn ?? null;

  const updatedAt = record['UpdatedAt'] ? new Date(record['UpdatedAt']) : null;
  const now = new Date();
  const ageH = updatedAt ? Math.floor((now - updatedAt) / 3_600_000) : null;

  // Ablaufdatum der Cookies prüfen (z.B. "2026-04-01") — <= heute gilt als abgelaufen
  const ablaufdatumStr = record['Ablaufdatum'];
  const todayStr = now.toISOString().split('T')[0];
  const cookieExpired = ablaufdatumStr ? ablaufdatumStr <= todayStr : false;

  let statusClass, statusIcon, statusText, sessionActive;
  if (ageH === null) {
    statusClass = 'status-unknown'; statusIcon = '?'; statusText = 'Unbekannt'; sessionActive = false;
  } else if (cookieExpired) {
    statusClass = 'status-error'; statusIcon = '✗'; statusText = 'Cookies abgelaufen'; sessionActive = false;
  } else if (chromiumLoggedIn === false) {
    // Chromium meldet explizit ausgeloggt (z.B. manueller Logout)
    statusClass = 'status-error'; statusIcon = '✗'; statusText = 'Ausgeloggt'; sessionActive = false;
  } else if (chromiumLoggedIn === true) {
    // Live-Check positiv → Session aktiv
    statusClass = 'status-ok'; statusIcon = '✓'; statusText = 'Session aktiv'; sessionActive = true;
  } else if (ageH < 6) {
    // chromiumLoggedIn === null (Chromium nicht erreichbar), aber Cookies gültig + frisch → aktiv
    statusClass = 'status-ok'; statusIcon = '✓'; statusText = 'Session aktiv'; sessionActive = true;
  } else if (ageH < 24) {
    // Chromium unbekannt, Cookies älter → Warnung, aber Button gesperrt (kein Grund zum Re-Login)
    statusClass = 'status-warn';  statusIcon = '⚠'; statusText = `Vor ${ageH}h sync.`; sessionActive = true;
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
      { label: 'Ablaufdatum',  value: ablaufdatumStr || '—' },
    ]
  };
}

async function triggerLogin(btn, sessionActive) {
  if (sessionActive) return; // Sicherheits-Guard
  btn.disabled = true;
  btn.textContent = '⏳ Logge ein (~30s)…';
  try {
    const session = getSession();
    if (!session?.username || !session?.password) {
      throw new Error('Keine Zugangsdaten – bitte Dashboard neu laden und einloggen');
    }

    // Schritt 1: CDP Login
    const loginRes = await fetch('/proxy/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: session?.username, password: session?.password }),
      signal: AbortSignal.timeout(65000)
    });
    const loginData = await loginRes.json();
    if (!loginData.success) throw new Error(loginData.error || 'Login fehlgeschlagen');

    btn.textContent = '⏳ Cookies holen…';

    // Schritt 2: Cookies aus Chromium holen
    const cookieRes = await fetch('/proxy/cookies', { signal: AbortSignal.timeout(15000) });
    const cookieData = await cookieRes.json();

    // Schritt 3: In Status-Store speichern (Dashboard-Live-Anzeige)
    if (cookieData.success) {
      fetch('/proxy/status-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'cookies',
          data: {
            cookieString: cookieData.cookieString,
            ablaufdatum:  cookieData.ablaufdatum,
            count:        cookieData.count,
            updatedAt:    new Date().toISOString(),
          }
        })
      }).catch(() => {});
    }

    // Schritt 4: n8n Cookie-Crawler triggern → speichert in NocoDB (Fallback)
    fetch('/proxy/n8n/api/v1/workflows/fgHKrok4oZYaYBry/run', {
      method: 'POST',
      headers: { 'X-N8N-API-KEY': CONFIG.n8n.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).catch(() => {});

    btn.textContent = '🔓 Eingeloggt!';
    btn.style.color = 'var(--ok, #4caf50)';
    btn.style.borderColor = 'var(--ok, #4caf50)';

    // Schritt 5: Karten nach 8s neu laden (n8n braucht etwas Zeit für NocoDB)
    setTimeout(() => {
      const wfCookie = document.getElementById('wf-cookie-crawler');
      const wfLogin  = document.getElementById('wf-joyclub-login');
      if (wfCookie) refreshWorkflow({ id: 'cookie-crawler', fetch: fetchCookieStatus, render: renderCookieCrawler });
      if (wfLogin)  refreshWorkflow({ id: 'joyclub-login',  fetch: fetchJoyclubLoginStatus, render: renderJoyclubLogin });
    }, 8000);

  } catch(e) {
    const msg = e.name === 'TimeoutError' ? 'Timeout (>65s)' : (e.message || 'Unbekannter Fehler');
    btn.textContent = '🔒 Fehler: ' + msg.substring(0, 60);
    btn.style.color = 'var(--pink)';
    btn.style.borderColor = 'var(--pink)';
    btn.disabled = false;
    console.error('[login] Fehler:', e);
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
