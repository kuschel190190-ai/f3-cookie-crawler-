// Workflow-Karte: Cookie Crawler / Auto-Login
// Liest alle Cookies aus NocoDB und zeigt Status + Ablaufdatum

async function fetchCookieStatus() {
  const { baseUrl, apiToken, projectId, tables } = CONFIG.nocodb;
  const url = `${baseUrl}/api/v1/db/data/noco/${projectId}/${tables.cookies}?limit=10`;

  const res = await fetch(url, { headers: { 'xc-token': apiToken } });
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

  return { statusClass: worstClass, statusText: worstText, statusIcon: worstIcon, rows };
}

function renderCookieCrawler(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);
}
