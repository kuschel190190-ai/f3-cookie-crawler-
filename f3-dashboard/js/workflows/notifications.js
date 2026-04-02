// Workflow-Karte: JOYclub Benachrichtigungen (live via CDP-Cookie-Fetch)

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchNotificationsData() {
  const res = await fetch('/proxy/notifications', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Notifications ${res.status}`);
  return res.json();
}

function renderNotifications(container, data) {
  const sectionBadge = document.getElementById('section-nachrichten-badge');
  const list = container.querySelector('.notif-list');

  const setBadge = (cls, icon, text) => {
    if (!sectionBadge) return;
    sectionBadge.className = `wf-status-badge ${cls}`;
    sectionBadge.querySelector('.wf-status-icon').textContent = icon;
    sectionBadge.querySelector('.wf-status-text').textContent = text;
  };

  if (data.error) {
    setBadge('status-error', '✗', 'Fehler');
    if (list) list.innerHTML = `<p class="notif-empty" style="color:var(--pink)">${escapeHtml(data.error)}</p>`;
    return;
  }

  if (data.loggedOut) {
    setBadge('status-error', '✗', 'Ausgeloggt');
    if (list) list.innerHTML = '<p class="notif-empty">Nicht eingeloggt – bitte JOYclub Login durchführen.</p>';
    return;
  }

  const count = data.totalCount || data.items.length;

  // Section badge
  if (count > 0) {
    setBadge('status-warn', count > 99 ? '99+' : String(count), `${count} neu`);
  } else {
    setBadge('status-ok', '✓', 'Keine neuen');
  }

  // Header-Badge im Topbar aktualisieren
  const headerBadge = document.getElementById('badge-notify-count');
  if (headerBadge) headerBadge.textContent = count > 99 ? '99+' : (count > 0 ? count : '');

  // Nav-Badge aktualisieren
  const navBadge = document.getElementById('nav-count-notify');
  if (navBadge) {
    navBadge.textContent = count > 0 ? (count > 99 ? '99+' : count) : '';
    navBadge.style.display = count > 0 ? '' : 'none';
  }

  if (!list) return;

  if (!data.items.length) {
    list.innerHTML = '<p class="notif-empty">Keine Benachrichtigungen vorhanden.</p>';
    return;
  }

  list.innerHTML = data.items.map(item => `
    <a class="notif-item${item.unread ? ' notif-item--unread' : ''}"
       href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
      <span class="notif-item-icon">${item.icon}</span>
      <span class="notif-item-body">
        <span class="notif-item-title">${escapeHtml(item.summary)}</span>
        ${item.entityName
          ? `<span class="notif-item-sub">${escapeHtml(item.entityName)}</span>`
          : ''}
      </span>
      <span class="notif-item-meta">
        ${item.date ? `<span class="notif-item-date">${escapeHtml(item.date)}</span>` : ''}
        ${item.time ? `<span class="notif-item-time">${escapeHtml(item.time)}</span>` : ''}
        ${item.unread ? '<span class="notif-unread-dot"></span>' : ''}
      </span>
    </a>`).join('');

  // Abgerufener Zeitstempel
  if (data.fetchedAt) {
    const ts = new Date(data.fetchedAt);
    const tsEl = container.querySelector('.notif-fetched-at');
    if (tsEl) tsEl.textContent = `Abgerufen: ${ts.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  }
}
