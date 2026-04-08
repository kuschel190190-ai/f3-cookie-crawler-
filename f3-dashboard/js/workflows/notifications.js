// Workflow-Karte: JOYclub Benachrichtigungen

const NOTIF_PAGE_SIZE = 10;
let notifAllItems   = [];
let notifShownCount = 0;
let notifTotalCount = 0;

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

  const setBadge = (cls, icon, text) => {
    if (!sectionBadge) return;
    sectionBadge.className = `wf-status-badge ${cls}`;
    sectionBadge.querySelector('.wf-status-icon').textContent = icon;
    sectionBadge.querySelector('.wf-status-text').textContent = text;
  };

  if (data.error) {
    setBadge('status-error', '✗', 'Fehler');
    container.innerHTML = `<p class="notif-empty" style="color:var(--pink)">${escapeHtml(data.error)}</p>`;
    return;
  }

  if (data.loggedOut) {
    setBadge('status-error', '✗', 'Ausgeloggt');
    container.innerHTML = '<p class="notif-empty">Nicht eingeloggt – bitte JOYclub Login durchführen.</p>';
    return;
  }

  notifAllItems   = data.items || [];
  notifTotalCount = data.totalCount || 0;
  notifShownCount = Math.min(NOTIF_PAGE_SIZE, notifAllItems.length);

  // Section-Badge + Nav-Badges
  if (notifTotalCount > 0) {
    const label = notifTotalCount > 99 ? '99+' : String(notifTotalCount);
    setBadge('status-warn', label, `${notifTotalCount} neu`);
  } else {
    setBadge('status-ok', '✓', 'Keine neuen');
  }
  const headerBadge = document.getElementById('badge-notify-count');
  if (headerBadge) headerBadge.textContent = notifTotalCount > 99 ? '99+' : (notifTotalCount > 0 ? notifTotalCount : '');
  const navBadge = document.getElementById('nav-count-notify');
  if (navBadge) {
    navBadge.textContent = notifTotalCount > 0 ? (notifTotalCount > 99 ? '99+' : notifTotalCount) : '';
    navBadge.style.display = notifTotalCount > 0 ? '' : 'none';
  }

  const fetchedAt = data.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : '';

  container.innerHTML = `
    <div class="notif-toolbar">
      <span class="notif-fetched-at">${fetchedAt ? 'Abgerufen: ' + fetchedAt : ''}</span>
      <button class="notif-mark-read-btn" id="notif-mark-read-btn"${notifTotalCount === 0 ? ' disabled' : ''}>
        ✓ Alle als gelesen markieren
      </button>
    </div>
    <div class="notif-list" id="notif-list"></div>
    <div class="notif-footer" id="notif-footer">
      <span class="notif-count-info" id="notif-count-info"></span>
      <div class="notif-footer-links">
        <button class="notif-load-more" id="notif-load-more" style="display:none">Weiterlesen →</button>
        <a class="notif-open-link" href="https://www.joyclub.de/benachrichtigung/" target="_blank" rel="noopener">Alle auf JOYclub →</a>
      </div>
    </div>`;

  renderNotifList();
  bindNotifEvents();
}

function renderNotifList() {
  const list = document.getElementById('notif-list');
  const info = document.getElementById('notif-count-info');
  const more = document.getElementById('notif-load-more');
  if (!list) return;

  const visible = notifAllItems.slice(0, notifShownCount);

  if (visible.length === 0) {
    list.innerHTML = '<p class="notif-empty">Keine Benachrichtigungen vorhanden.</p>';
    if (info) info.textContent = '';
    if (more) more.style.display = 'none';
    return;
  }

  list.innerHTML = visible.map(item => {
    const avatarHtml = item.avatar
      ? `<img class="notif-item-avatar" src="${escapeHtml(item.avatar)}" alt="" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<span class="notif-item-avatar notif-item-avatar--fallback" style="display:none">${item.icon}</span>`
      : `<span class="notif-item-avatar notif-item-avatar--fallback">${item.icon}</span>`;

    return `<a class="notif-item${item.unread ? ' notif-item--unread' : ''}"
         href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
      ${avatarHtml}
      <span class="notif-item-body">
        <span class="notif-item-title">${escapeHtml(item.title)}</span>
        ${item.subtitle ? `<span class="notif-item-sub">${escapeHtml(item.subtitle)}</span>` : ''}
        ${item.category ? `<span class="notif-item-cat">${escapeHtml(item.category)}</span>` : ''}
      </span>
      <span class="notif-item-meta">
        ${item.date ? `<span class="notif-item-date">${escapeHtml(item.date)}</span>` : ''}
        ${item.unread ? '<span class="notif-unread-dot"></span>' : ''}
      </span>
    </a>`;
  }).join('');

  if (info) info.textContent = `${visible.length} von ${notifAllItems.length}`;
  if (more) more.style.display = notifShownCount < notifAllItems.length ? '' : 'none';
}

function bindNotifEvents() {
  document.getElementById('notif-load-more')?.addEventListener('click', () => {
    notifShownCount = Math.min(notifShownCount + NOTIF_PAGE_SIZE, notifAllItems.length);
    renderNotifList();
  });

  document.getElementById('notif-mark-read-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '⏳ Markiere…';
    try {
      const res = await fetch('/proxy/notifications/mark-read', {
        method: 'POST',
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      // UI: alle Items als gelesen, Counter → 0
      notifAllItems   = notifAllItems.map(i => ({ ...i, unread: false }));
      notifTotalCount = 0;
      renderNotifList();

      const sectionBadge = document.getElementById('section-nachrichten-badge');
      if (sectionBadge) {
        sectionBadge.className = 'wf-status-badge status-ok';
        sectionBadge.querySelector('.wf-status-icon').textContent = '✓';
        sectionBadge.querySelector('.wf-status-text').textContent = 'Keine neuen';
      }
      const headerBadge = document.getElementById('badge-notify-count');
      if (headerBadge) headerBadge.textContent = '';
      const navBadge = document.getElementById('nav-count-notify');
      if (navBadge) { navBadge.textContent = ''; navBadge.style.display = 'none'; }

      btn.textContent = '✓ Alle gelesen';
      setTimeout(() => { btn.textContent = '✓ Alle als gelesen markieren'; }, 2000);
    } catch(err) {
      btn.disabled = false;
      btn.textContent = '✗ Fehler: ' + err.message.substring(0, 40);
      setTimeout(() => { btn.textContent = '✓ Alle als gelesen markieren'; btn.disabled = false; }, 3000);
    }
  });
}
