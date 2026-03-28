// F3 Auto-Post – Sektion
//
// Phase 1: Daten aus NocoDB View "post-f3" (vw9cir6o64c0hg7v)
// Phase 2: Daten aus /proxy/autopost-status (n8n schreibt direkt rein)
//          → Quelle wechseln: AUTOPOST_SOURCE = 'status'

const AUTOPOST_SOURCE  = 'nocodb';   // 'nocodb' | 'status'
const AUTOPOST_VIEW_ID = 'vw9cir6o64c0hg7v';

// ── Datenabruf ────────────────────────────────────────────────────────────────

async function fetchAutopostData() {
  if (AUTOPOST_SOURCE === 'status') {
    // Phase 2: n8n hat Daten direkt reingeschrieben
    const res = await fetch('/proxy/autopost-status', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Status-Endpoint ' + res.status);
    return await res.json();
  }

  // Phase 1: NocoDB View "post-f3"
  const url = CONFIG.nocodb.baseUrl
    + '/api/v1/db/data/noco/' + CONFIG.nocodb.projectId
    + '/' + CONFIG.nocodb.tables.events
    + '?viewId=' + AUTOPOST_VIEW_ID
    + '&limit=50';

  const res = await fetch(url, {
    headers: { 'xc-token': CONFIG.nocodb.apiToken },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('NocoDB ' + res.status);
  const data = await res.json();
  return { source: 'nocodb', records: data.list || data.records || [] };
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderAutopost(container, data) {
  const badge = document.getElementById('section-autopost-badge');

  // Phase 2: Status-Endpoint Daten
  if (data.source === 'status' || data.lastRunAt) {
    renderAutopostStatus(container, badge, data);
    return;
  }

  // Phase 1: NocoDB Records
  const records = data.records || [];

  if (badge) {
    if (records.length === 0) {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '⚠';
      badge.querySelector('.wf-status-text').textContent = 'Keine Posts';
    } else {
      badge.className = 'wf-status-badge status-ok';
      badge.querySelector('.wf-status-icon').textContent = '✓';
      badge.querySelector('.wf-status-text').textContent = records.length + ' Posts';
    }
  }

  if (records.length === 0) {
    container.innerHTML = '<p style="color:var(--muted);padding:8px 0">Keine Auto-Post Einträge gefunden.</p>';
    return;
  }

  // Felder aus dem ersten Record ableiten (dynamisch)
  const skip = new Set(['Id', 'CreatedAt', 'UpdatedAt', 'nc_order']);
  const firstRec = records[0];
  const fields = Object.keys(firstRec).filter(k => !skip.has(k));

  // Status-Feld erkennen für Farbcodierung
  const statusField = fields.find(f => /status|state|zustand/i.test(f));

  const cards = records.map(rec => {
    const statusVal = statusField ? (rec[statusField] || '') : '';
    const statusCls = /gepostet|posted|ok|done|success/i.test(statusVal) ? 'status-ok'
      : /fehler|error|fail/i.test(statusVal) ? 'status-error'
      : /geplant|scheduled|pending/i.test(statusVal) ? 'status-warn'
      : '';

    const rows = fields.map(f => {
      const val = rec[f];
      if (val === null || val === undefined || val === '') return '';
      return '<div class="autopost-row">'
        + '<span class="autopost-label">' + f + '</span>'
        + '<span class="autopost-value">' + String(val) + '</span>'
        + '</div>';
    }).join('');

    return '<div class="autopost-card' + (statusCls ? ' autopost-' + statusCls : '') + '">'
      + (statusField && statusVal
          ? '<div class="autopost-status ' + statusCls + '">' + statusVal + '</div>'
          : '')
      + rows
      + '</div>';
  }).join('');

  container.innerHTML = '<div class="autopost-list">' + cards + '</div>';
}

function renderAutopostStatus(container, badge, data) {
  // Phase 2: strukturierte Daten von n8n
  const posts = data.posts || data.events || [];
  const lastRun = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString('de-DE') : '—';
  const ok = posts.filter(p => /ok|success|gepostet/i.test(p.status || '')).length;
  const err = posts.filter(p => /error|fehler/i.test(p.status || '')).length;

  if (badge) {
    if (err > 0) {
      badge.className = 'wf-status-badge status-error';
      badge.querySelector('.wf-status-icon').textContent = '✗';
      badge.querySelector('.wf-status-text').textContent = err + ' Fehler';
    } else if (ok > 0) {
      badge.className = 'wf-status-badge status-ok';
      badge.querySelector('.wf-status-icon').textContent = '✓';
      badge.querySelector('.wf-status-text').textContent = ok + ' gepostet';
    } else {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '◷';
      badge.querySelector('.wf-status-text').textContent = 'Kein Status';
    }
  }

  const rows = posts.map(p => {
    const cls = /ok|success|gepostet/i.test(p.status || '') ? 'status-ok'
      : /error|fehler/i.test(p.status || '') ? 'status-error' : 'status-warn';
    return '<div class="autopost-card autopost-' + cls + '">'
      + '<div class="autopost-status ' + cls + '">' + (p.status || '—') + '</div>'
      + '<div class="autopost-row"><span class="autopost-label">Event</span><span class="autopost-value">' + (p.eventName || p.event || '—') + '</span></div>'
      + (p.platform ? '<div class="autopost-row"><span class="autopost-label">Plattform</span><span class="autopost-value">' + p.platform + '</span></div>' : '')
      + (p.postedAt ? '<div class="autopost-row"><span class="autopost-label">Gepostet</span><span class="autopost-value">' + new Date(p.postedAt).toLocaleString('de-DE') + '</span></div>' : '')
      + '</div>';
  }).join('');

  container.innerHTML = '<div class="autopost-meta">Letzter Lauf: <strong>' + lastRun + '</strong></div>'
    + '<div class="autopost-list">' + rows + '</div>';
}
