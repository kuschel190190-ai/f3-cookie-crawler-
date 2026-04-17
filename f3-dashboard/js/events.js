// Dashboard – Events Sektion
// Quelle 1: server.js Status Store (von Teilnehmer-Sync befüllt, kein NocoDB)
// Quelle 2: NocoDB (Fallback solange Status Store leer ist)

async function fetchEventsData() {
  // Quelle 1: Status Store (Scraping-Daten von n8n)
  let raw = [];
  try {
    const statusRes = await fetch('/proxy/events-status', { signal: AbortSignal.timeout(5000) });
    if (statusRes.ok) {
      const status = await statusRes.json();
      if (status?.events?.length) {
        raw = status.events;
        console.log('[events] Quelle: Status Store (' + raw.length + ' Events)');
      }
    }
  } catch(e) {
    console.warn('[events] Status Store nicht erreichbar, nutze NocoDB Fallback');
  }

  // Quelle 2: SQLite API Fallback
  let source = 'JOYclub';
  if (!raw.length) {
    source = 'SQLite';
    const res = await fetch('/api/events?limit=100');
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    raw = data.list || [];
    console.log('[events] Quelle: SQLite API (' + raw.length + ' Events)');
  }
  // Deduplizieren: per Id, EventLink (eindeutige JOYclub-URL) + bereinigtem Namen (Emojis raus)
  const seenId   = new Set();
  const seenLink = new Set();
  const seenName = new Set();
  const all = raw.filter(ev => {
    if (seenId.has(ev.Id)) return false;
    seenId.add(ev.Id);
    // EventLink ist am zuverlässigsten (eindeutige URL pro Event)
    if (ev.EventLink) {
      if (seenLink.has(ev.EventLink)) return false;
      seenLink.add(ev.EventLink);
    }
    // Fallback: Name ohne Emojis/Sonderzeichen vergleichen
    const key = (ev.EventName || '').replace(/[^\x20-\x7E]/g, '').trim().toLowerCase();
    if (key && seenName.has(key)) return false;
    if (key) seenName.add(key);
    return true;
  });

  const today = new Date(); today.setHours(0, 0, 0, 0);

  function parseDate(raw) {
    if (!raw) return null;
    const m = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? new Date(m[3], m[2]-1, m[1]) : new Date(raw);
  }

  const aktiv = all.filter(ev => {
    if (ev.Status === 'abgesagt' || ev.Status === 'verschoben' || ev.Status === 'inaktiv') return false;
    const d = parseDate(ev.EventDatum);
    return !d || d >= today;
  });

  const archiv = all.filter(ev =>
    ev.Status === 'abgesagt' || ev.Status === 'verschoben'
  );

  const past = all.filter(ev => {
    if (ev.Status === 'abgesagt' || ev.Status === 'verschoben') return false;
    if (ev.Status === 'inaktiv') return true;
    const d = parseDate(ev.EventDatum);
    return d && d < today;
  });

  return { aktiv, archiv, past, source };
}

function renderEvents(container, { aktiv, archiv, past, source }) {
  const badge = document.getElementById('section-events-badge');
  if (badge) {
    if (aktiv.length > 0) {
      badge.className = 'wf-status-badge status-ok';
      badge.querySelector('.wf-status-icon').textContent = '✓';
      badge.querySelector('.wf-status-text').textContent = aktiv.length + ' aktiv';
    } else {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '⚠';
      badge.querySelector('.wf-status-text').textContent = 'Keine Events';
    }
  }

  // Datenquelle-Badge in Section-Header
  const hdr = document.getElementById('hdr-events');
  if (hdr && !hdr.querySelector('.wf-source-badge')) {
    const srcBadge = document.createElement('span');
    srcBadge.className = 'wf-source-badge';
    srcBadge.textContent = source === 'JOYclub' ? '🔗 JOYclub' : '🗄 SQLite';
    hdr.querySelector('.section-title').after(srcBadge);
  } else if (hdr) {
    const srcBadge = hdr.querySelector('.wf-source-badge');
    if (srcBadge) srcBadge.textContent = source === 'JOYclub' ? '🔗 JOYclub' : '🗄 SQLite';
  }

  function stat(cls, label, value) {
    const v = (value !== null && value !== undefined && value !== '') ? value : '–';
    return '<div class="event-stat ' + cls + '">'
      + '<span class="event-stat-label">' + label + '</span>'
      + '<span class="event-stat-value">' + v + '</span>'
      + '</div>';
  }

  function countdownBadge(dateStr) {
    if (!dateStr) return '';
    const m = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const d = m ? new Date(m[3], m[2]-1, m[1]) : new Date(dateStr);
    if (isNaN(d)) return '';
    const days = Math.ceil((d - new Date().setHours(0,0,0,0)) / 86400000);
    if (days < 0) return '';
    if (days === 0) return '<span class="event-countdown today">Heute</span>';
    if (days === 1) return '<span class="event-countdown today">Morgen</span>';
    if (days <= 7)  return '<span class="event-countdown soon">in ' + days + ' Tagen</span>';
    return '<span class="event-countdown">in ' + days + ' Tagen</span>';
  }

  function eventCard(ev) {
    const preise = (ev.Preise || '').trim();
    return '<div class="event-card">'
      + '<div class="event-header">'
      +   '<span class="event-date">📅 ' + (ev.EventDatum || '–') + '</span>'
      +   countdownBadge(ev.EventDatum)
      +   (ev.Wochentag ? '<span class="event-post-day">📣 ' + ev.Wochentag + '</span>' : '')
      +   (ev.EventLink
            ? '<a class="event-name event-name-link" href="' + ev.EventLink + '" target="_blank" rel="noopener">' + (ev.EventName || '–') + '</a>'
            : '<span class="event-name">' + (ev.EventName || '–') + '</span>')
      + '</div>'
      + '<div class="event-stats">'
      +   stat('',        'Angemeldet',  ev.Angemeldet)
      +   stat('',        'Unbestätigt', ev.NichtBestaetigt)
      +   stat('men',     'Männer',      ev.Maenner)
      +   stat('women',   'Frauen',      ev.Frauen)
      +   stat('couples', 'Paare',       ev.Paare)
      +   stat('',        'Vorgemerkt',  ev.Vorgemerkt)
      +   stat('',        'Aufrufe',     ev.Aufrufe)
      + '</div>'
      + (preise
        ? '<details class="event-preise" style="margin-top:0.4rem;font-size:0.8rem">'
          + '<summary style="cursor:pointer;color:var(--accent, #c074e8);list-style:none;display:flex;align-items:center;gap:0.3rem">'
          + '🎟 Preise einblenden</summary>'
          + '<div style="padding:0.35rem 0.25rem;color:var(--text, #eee);line-height:1.6">' + preise + '</div>'
          + '</details>'
        : '')
      + '</div>';
  }

  const aktivCards = aktiv.map(eventCard).join('');

  const archivCards = archiv.length
    ? '<details class="events-archiv" style="margin-top:1rem" open>'
      + '<summary style="cursor:pointer;font-size:0.82rem;color:var(--muted,#888);padding:0.3rem 0;list-style:none;display:flex;align-items:center;gap:0.4rem">'
      + '▸ Archiv – Abgesagt / Verschoben (' + archiv.length + ')</summary>'
      + archiv.map(ev => {
          const statusColor = ev.Status === 'abgesagt' ? '#e85656' : '#e8a556';
          return '<div class="event-card" style="opacity:0.65;border-top-color:' + statusColor + ';margin-top:0.4rem">'
            + '<div class="event-header">'
            +   '<span class="event-date">📅 ' + (ev.EventDatum || '–') + '</span>'
            +   (ev.EventLink
                  ? '<a class="event-name event-name-link" href="' + ev.EventLink + '" target="_blank" rel="noopener">' + (ev.EventName || '–') + '</a>'
                  : '<span class="event-name">' + (ev.EventName || '–') + '</span>')
            +   '<span style="font-size:0.75rem;padding:0.15rem 0.45rem;border-radius:4px;background:' + statusColor + '22;color:' + statusColor + '">'
            +     (ev.Status === 'abgesagt' ? '✗ Abgesagt' : '⟳ Verschoben')
            +   '</span>'
            + '</div>'
            + '</div>';
        }).join('')
      + '</details>'
    : '';

  container.innerHTML = '<div class="events-list">' + aktivCards + archivCards + '</div>';
}
