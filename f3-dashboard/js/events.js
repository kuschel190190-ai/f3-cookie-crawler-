// Dashboard – Events Sektion (liest direkt aus NocoDB)

async function fetchEventsData() {
  const url = CONFIG.nocodb.baseUrl
    + '/api/v1/db/data/noco/' + CONFIG.nocodb.projectId
    + '/' + CONFIG.nocodb.tables.events
    + '?limit=100';

  const res = await fetch(url, {
    headers: { 'xc-token': CONFIG.nocodb.apiToken }
  });
  if (!res.ok) throw new Error('NocoDB ' + res.status);
  const data = await res.json();
  const all = data.list || data.records || [];

  const today = new Date(); today.setHours(0, 0, 0, 0);

  function parseDate(raw) {
    if (!raw) return null;
    const m = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? new Date(m[3], m[2]-1, m[1]) : new Date(raw);
  }

  const upcoming = all.filter(ev => {
    if (ev.Status === 'inaktiv') return false;
    const d = parseDate(ev.EventDatum);
    return !d || d >= today;
  });
  const past = all.filter(ev => {
    if (ev.Status === 'inaktiv') return true;
    const d = parseDate(ev.EventDatum);
    return d && d < today;
  });

  return { upcoming, past };
}

function renderEvents(container, { upcoming, past }) {
  const badge = document.getElementById('section-events-badge');
  if (badge) {
    if (upcoming.length > 0) {
      badge.className = 'wf-status-badge status-ok';
      badge.querySelector('.wf-status-icon').textContent = '✓';
      badge.querySelector('.wf-status-text').textContent = upcoming.length + ' aktiv';
    } else {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '⚠';
      badge.querySelector('.wf-status-text').textContent = 'Keine Events';
    }
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

  const upcomingCards = upcoming.map(ev =>
    '<div class="event-card">'
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
    + '</div>'
  ).join('');

  const pastCards = past.map(ev =>
    '<div class="event-card" style="opacity:0.4;border-top-color:var(--muted)">'
    + '<div class="event-header">'
    +   '<span class="event-date">📅 ' + (ev.EventDatum || '–') + '</span>'
    +   '<span class="event-name">' + (ev.EventName || '–') + '</span>'
    +   '<span style="color:var(--muted);font-size:11px">vergangen</span>'
    + '</div>'
    + '</div>'
  ).join('');

  container.innerHTML = '<div class="events-list">' + upcomingCards + pastCards + '</div>';
}
