// Workflow-Karte: Cookie Crawler / Auto-Login
// Liest alle Cookies aus NocoDB und zeigt Status + Ablaufdatum

async function fetchCookieStatus() {
  const { baseUrl, apiToken, projectId, tables } = CONFIG.nocodb;
  const url = `${baseUrl}/api/v1/db/data/noco/${projectId}/${tables.cookies}?limit=10`;

  // NocoDB + n8n Cookie Sync Status parallel
  const [res, syncResult] = await Promise.all([
    fetch(url, { headers: { 'xc-token': apiToken } }),
    getWorkflowExecsByName('cookie sync').catch(() => null),
  ]);
  if (!res.ok) throw new Error(`NocoDB ${res.status}`);
  const data = await res.json();
  const records = data.list ?? [];
  if (!records.length) throw new Error('Keine Cookie-Einträge gefunden');

  const now = new Date();

  function cookieStatus(record) {
    const ablauf = record['Ablaufdatum'];
    const expiry = ablauf ? new Date(ablauf) : null;
    const diffDays = expiry ? Math.floor((expiry - now) / 86_400_000) : null;
    return { expiry, diffDays };
  }

  // Schlechtester Status bestimmt die Karten-Farbe
  let worstClass = 'status-ok';
  let worstText = 'Alle aktiv';
  let worstIcon = '✓';

  // Globaler Cookie-Status für andere Komponenten (z.B. Auto-Post Lock)
  const f3Rec = records.find(r => (r['Name'] || '').toLowerCase().includes('f3-events'));
  const f3Status = f3Rec ? cookieStatus(f3Rec) : null;
  window.f3CookieOk = f3Status ? (f3Status.diffDays !== null && f3Status.diffDays > 0) : null;

  const rows = [];
  for (const rec of records) {
    const { expiry, diffDays } = cookieStatus(rec);
    let badge = '✓';
    let sc = 'ok';

    if (diffDays === null) {
      badge = '?'; sc = 'unknown';
      if (worstClass === 'status-ok') { worstClass = 'status-unknown'; worstText = 'Unbekannt'; worstIcon = '?'; }
    } else if (diffDays < 0) {
      badge = '✗'; sc = 'error';
      worstClass = 'status-error'; worstText = 'Cookie abgelaufen'; worstIcon = '✗';
    } else if (diffDays <= 3) {
      badge = '⚠'; sc = 'warn';
      if (worstClass !== 'status-error') { worstClass = 'status-warn'; worstText = `Läuft ab in ${diffDays}d`; worstIcon = '⚠'; }
    }

    const ablaufText = expiry
      ? expiry.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'kein Datum';
    const daysText = diffDays === null ? '' : diffDays < 0 ? ` (${Math.abs(diffDays)}d abgelaufen)` : diffDays === 0 ? ' (heute)' : ` (${diffDays}d)`;

    rows.push({ label: rec['Name'] || '—', value: `${badge} ${ablaufText}${daysText}` });
  }

  // n8n Cookie Sync Ausführungs-Status als erste Zeile
  if (syncResult) {
    const lastExec = syncResult.executions[0];
    const syncIcon = !lastExec
      ? '◷'
      : lastExec.status === 'success' ? '✓'
      : lastExec.status === 'error'   ? '✗'
      : '⚠';
    const syncTime = relativeTime(lastExec?.startedAt);
    const syncLink  = lastExec?.id
      ? ` <a href="https://n8n.f3-events.de/workflow/${syncResult.id}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.75em">n8n →</a>`
      : '';
    rows.unshift({ label: 'n8n Sync', value: syncIcon + ' ' + syncTime + syncLink });
  }

  return { statusClass: worstClass, statusText: worstText, statusIcon: worstIcon, rows };
}

function renderCookieCrawler(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);

  const btn = container.querySelector('.btn-cookie-sync');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '⏳ Cookies werden geholt…';
    btn.style.color = '';
    try {
      const res = await fetch('/proxy/cookies', { signal: AbortSignal.timeout(15000) });
      const d = await res.json();
      if (!d.success) throw new Error(d.error || 'Fehler');
      btn.textContent = `✓ ${d.count} Cookies · ${d.ablaufdatum || '?'}`;
      btn.style.color = 'var(--ok, #4caf50)';
      setTimeout(() => {
        btn._bound = false; btn.style.color = '';
        refreshWorkflow({ id: 'cookie-crawler', fetch: fetchCookieStatus, render: renderCookieCrawler });
        refreshWorkflow({ id: 'joyclub-login',  fetch: fetchJoyclubLoginStatus, render: renderJoyclubLogin });
        refreshAutopost();
      }, 3000);
    } catch(e) {
      btn.textContent = '✗ ' + (e.message || 'Fehler').substring(0, 50);
      btn.style.color = 'var(--pink)';
      btn.disabled = false;
    }
  });
}
