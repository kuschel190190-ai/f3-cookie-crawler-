// Server-Auslastung – Hetzner via /metrics Endpoint des Cookie-Crawlers
// Warnt bei CPU oder RAM > 80%

async function fetchServerMetrics() {
  const res = await fetch('https://f3-cookie-crawler.f3-events.de/metrics', {
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Metrics ${res.status}`);
  const d = await res.json();

  const cpuPct = d.cpu?.pct ?? 0;
  const ramPct = d.ram?.pct ?? 0;
  const worst  = Math.max(cpuPct, ramPct);

  let statusClass, statusIcon, statusText;
  if (worst >= 80)      { statusClass = 'status-error'; statusIcon = '✗'; statusText = 'Überlastet'; }
  else if (worst >= 60) { statusClass = 'status-warn';  statusIcon = '⚠'; statusText = 'Erhöht';     }
  else                  { statusClass = 'status-ok';    statusIcon = '✓'; statusText = 'Normal';      }

  const uptime = d.uptime || 0;
  const uptimeH = Math.floor(uptime / 3600);
  const uptimeM = Math.floor((uptime % 3600) / 60);

  return {
    statusClass, statusIcon, statusText,
    rows: [
      { label: 'CPU',    value: cpuPct + '% (Load ' + d.cpu?.load1 + ')' },
      { label: 'RAM',    value: ramPct + '% (' + d.ram?.usedMB + ' / ' + d.ram?.totalMB + ' MB)' },
      { label: 'Uptime', value: uptimeH + 'h ' + uptimeM + 'min' },
    ]
  };
}

function renderServerMetrics(container, data) {
  container.querySelector('.wf-status-badge').className = `wf-status-badge ${data.statusClass}`;
  container.querySelector('.wf-status-icon').textContent = data.statusIcon;
  container.querySelector('.wf-status-text').textContent = data.statusText;
  renderRows(container, data.rows);
}
