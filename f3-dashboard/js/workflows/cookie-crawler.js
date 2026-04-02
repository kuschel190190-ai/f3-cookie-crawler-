// Workflow-Karte: Cookie Crawler / Auto-Login
// Liest Cookies aus /api/cookies (server.js → SQLite/NocoDB)

async function fetchCookieStatus() {
  // /api/cookies + n8n Cookie Sync Status parallel
  const [res, syncResult] = await Promise.all([
    fetch('/api/cookies'),
    getWorkflowExecsByName('cookie sync').catch(() => null),
  ]);
  if (!res.ok) throw new Error(`/api/cookies ${res.status}`);
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

  let worstClass = 'status-ok';
  let worstText  = 'Alle aktiv';
  let worstIcon  = '✓';

  const f3Rec = records.find(r => (r['Name'] || '').toLowerCase().includes('f3-events'));
  const f3Status = f3Rec ? cookieStatus(f3Rec) : null;
  window.f3CookieOk = f3Status ? (f3Status.diffDays !== null && f3Status.diffDays > 0) : null;

  // Aktuellen Cookie-String für die aufklappbare Anzeige
  const cookieString = f3Rec?.Cookie || records[0]?.Cookie || '';

  const rows = [];
  for (const rec of records) {
    const { expiry, diffDays } = cookieStatus(rec);
    let badge = '✓';

    if (diffDays === null) {
      badge = '?';
      if (worstClass === 'status-ok') { worstClass = 'status-unknown'; worstText = 'Unbekannt'; worstIcon = '?'; }
    } else if (diffDays < 0) {
      badge = '✗';
      worstClass = 'status-error'; worstText = 'Cookie abgelaufen'; worstIcon = '✗';
    } else if (diffDays <= 3) {
      badge = '⚠';
      if (worstClass !== 'status-error') { worstClass = 'status-warn'; worstText = `Läuft ab in ${diffDays}d`; worstIcon = '⚠'; }
    }

    const ablaufText = expiry
      ? expiry.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : 'kein Datum';
    const daysText = diffDays === null ? '' : diffDays < 0 ? ` (${Math.abs(diffDays)}d abgelaufen)` : diffDays === 0 ? ' (heute)' : ` (${diffDays}d)`;

    rows.push({ label: rec['Name'] || '—', value: `${badge} ${ablaufText}${daysText}` });
  }

  if (syncResult) {
    const lastExec = syncResult.executions[0];
    const syncIcon = !lastExec ? '◷' : lastExec.status === 'success' ? '✓' : lastExec.status === 'error' ? '✗' : '⚠';
    const syncTime = relativeTime(lastExec?.startedAt);
    const syncLink = lastExec?.id
      ? ` <a href="https://n8n.f3-events.de/workflow/${syncResult.id}" target="_blank" rel="noopener" style="color:var(--muted);font-size:0.75em">n8n →</a>`
      : '';
    rows.unshift({ label: 'n8n Sync', value: syncIcon + ' ' + syncTime + syncLink });
  }

  return { statusClass: worstClass, statusText: worstText, statusIcon: worstIcon, rows, cookieString };
}

function renderCookieCrawler(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);

  // Cookie-Detail Anzeige befüllen
  const preview = container.querySelector('.cookie-string-preview');
  if (preview) {
    const cs = data.cookieString || '';
    preview.textContent = cs ? cs.substring(0, 300) + (cs.length > 300 ? '…' : '') : '(kein Cookie gespeichert)';
    preview.title = cs;
    const copyBtn = container.querySelector('.btn-copy-cookie');
    if (copyBtn && !copyBtn._bound) {
      copyBtn._bound = true;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(cs).then(() => {
          copyBtn.textContent = '✓ Kopiert';
          setTimeout(() => { copyBtn.textContent = '📋 Kopieren'; }, 1500);
        });
      });
    }
    // Cookie-Anzahl
    const count = cs ? cs.split(';').filter(Boolean).length : 0;
    const countEl = container.querySelector('.cookie-count');
    if (countEl) countEl.textContent = count ? `${count} Cookies` : '';
  }

  // Cookie-Toggle
  const toggle = container.querySelector('.cookie-detail-toggle');
  const body   = container.querySelector('.cookie-detail-body');
  if (toggle && body && !toggle._bound) {
    toggle._bound = true;
    toggle.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      toggle.querySelector('.toggle-arrow').textContent = open ? '▶' : '▼';
    });
  }

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
