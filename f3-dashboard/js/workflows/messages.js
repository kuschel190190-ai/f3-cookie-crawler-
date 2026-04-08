// Workflow-Karte: JOYclub Nachrichten (ClubMail)

const MSG_PAGE_SIZE = 10;
let msgAllItems    = [];
let msgShownCount  = 0;
let msgTotalCount  = 0;
let msgCurrentId   = null;   // geöffneter Thread

function msgEscapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchMessagesData() {
  const res = await fetch('/proxy/messages', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Messages ${res.status}`);
  return res.json();
}

function renderMessages(container, data) {
  const sectionBadge = document.getElementById('section-messages-badge');

  const setBadge = (cls, icon, text) => {
    if (!sectionBadge) return;
    sectionBadge.className = `wf-status-badge ${cls}`;
    sectionBadge.querySelector('.wf-status-icon').textContent = icon;
    sectionBadge.querySelector('.wf-status-text').textContent = text;
  };

  if (data.error) {
    setBadge('status-error', '✗', 'Fehler');
    container.innerHTML = `<p class="notif-empty" style="color:var(--pink)">${msgEscapeHtml(data.error)}</p>`;
    return;
  }

  if (data.loggedOut) {
    setBadge('status-error', '✗', 'Ausgeloggt');
    container.innerHTML = '<p class="notif-empty">Nicht eingeloggt – bitte JOYclub Login durchführen.</p>';
    return;
  }

  msgAllItems   = data.items || [];
  msgTotalCount = data.totalCount || 0;
  msgShownCount = Math.min(MSG_PAGE_SIZE, msgAllItems.length);

  if (msgTotalCount > 0) {
    const label = msgTotalCount > 99 ? '99+' : String(msgTotalCount);
    setBadge('status-warn', label, `${msgTotalCount} neu`);
  } else {
    setBadge('status-ok', '✓', 'Keine neuen');
  }

  // Header + Nav Badges
  const headerBadge = document.getElementById('badge-mail-count');
  if (headerBadge) headerBadge.textContent = msgTotalCount > 99 ? '99+' : (msgTotalCount > 0 ? msgTotalCount : '');
  const navBadge = document.getElementById('nav-count-messages');
  if (navBadge) {
    navBadge.textContent = msgTotalCount > 0 ? (msgTotalCount > 99 ? '99+' : msgTotalCount) : '';
    navBadge.style.display = msgTotalCount > 0 ? '' : 'none';
  }

  const fetchedAt = data.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : '';

  container.innerHTML = `
    <div class="msg-layout">
      <div class="msg-list-panel" id="msg-list-panel">
        <div class="notif-toolbar">
          <span class="notif-fetched-at">${fetchedAt ? 'Abgerufen: ' + fetchedAt : ''}</span>
          <a class="notif-open-link" href="https://www.joyclub.de/nachrichten/" target="_blank" rel="noopener">Alle auf JOYclub →</a>
        </div>
        <div class="msg-list" id="msg-list"></div>
        <div class="notif-footer" id="msg-footer">
          <span class="notif-count-info" id="msg-count-info"></span>
          <button class="notif-load-more" id="msg-load-more" style="display:none">Weiterlesen →</button>
        </div>
      </div>
      <div class="msg-thread-panel" id="msg-thread-panel" style="display:none">
        <div class="msg-thread-header" id="msg-thread-header">
          <button class="msg-back-btn" id="msg-back-btn">← Zurück</button>
          <span class="msg-thread-name" id="msg-thread-name"></span>
          <a class="msg-thread-link" id="msg-thread-link" href="#" target="_blank" rel="noopener">↗ JOYclub</a>
        </div>
        <div class="msg-thread-body" id="msg-thread-body">
          <div class="msg-thread-loading">Lädt…</div>
        </div>
        <div class="msg-reply-box" id="msg-reply-box">
          <textarea class="msg-reply-textarea" id="msg-reply-textarea" placeholder="Antwort schreiben…" rows="3"></textarea>
          <div class="msg-reply-actions">
            <span class="msg-draft-label" id="msg-draft-label"></span>
            <button class="msg-reply-send" id="msg-reply-send">Senden ✉</button>
          </div>
        </div>
      </div>
    </div>`;

  renderMsgList();
  bindMsgEvents();
}

function renderMsgList() {
  const list  = document.getElementById('msg-list');
  const info  = document.getElementById('msg-count-info');
  const more  = document.getElementById('msg-load-more');
  if (!list) return;

  const visible = msgAllItems.slice(0, msgShownCount);

  if (visible.length === 0) {
    list.innerHTML = '<p class="notif-empty">Keine Nachrichten vorhanden.</p>';
    if (info) info.textContent = '';
    if (more) more.style.display = 'none';
    return;
  }

  list.innerHTML = visible.map(item => {
    const avatarHtml = item.avatar
      ? `<img class="notif-item-avatar" src="${msgEscapeHtml(item.avatar)}" alt="" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<span class="notif-item-avatar notif-item-avatar--fallback" style="display:none">💬</span>`
      : `<span class="notif-item-avatar notif-item-avatar--fallback">💬</span>`;

    return `<div class="notif-item msg-item${item.unread ? ' notif-item--unread' : ''}"
         data-msg-id="${msgEscapeHtml(item.id)}"
         data-msg-url="${msgEscapeHtml(item.url)}"
         data-msg-name="${msgEscapeHtml(item.name)}">
      ${avatarHtml}
      <span class="notif-item-body">
        <span class="notif-item-title">${msgEscapeHtml(item.name)}</span>
        ${item.preview ? `<span class="notif-item-sub">${msgEscapeHtml(item.preview)}</span>` : ''}
      </span>
      <span class="notif-item-meta">
        ${item.date ? `<span class="notif-item-date">${msgEscapeHtml(item.date)}</span>` : ''}
        ${item.unread ? '<span class="notif-unread-dot"></span>' : ''}
      </span>
    </div>`;
  }).join('');

  if (info) info.textContent = `${visible.length} von ${msgAllItems.length}`;
  if (more) more.style.display = msgShownCount < msgAllItems.length ? '' : 'none';
}

function bindMsgEvents() {
  document.getElementById('msg-load-more')?.addEventListener('click', () => {
    msgShownCount = Math.min(msgShownCount + MSG_PAGE_SIZE, msgAllItems.length);
    renderMsgList();
  });

  document.getElementById('msg-list')?.addEventListener('click', e => {
    const item = e.target.closest('.msg-item');
    if (!item) return;
    const id   = item.dataset.msgId;
    const url  = item.dataset.msgUrl;
    const name = item.dataset.msgName;
    openMsgThread(id, url, name);
  });

  document.getElementById('msg-back-btn')?.addEventListener('click', () => {
    document.getElementById('msg-thread-panel').style.display = 'none';
    document.getElementById('msg-list-panel').style.display = '';
    msgCurrentId = null;
  });

  document.getElementById('msg-reply-send')?.addEventListener('click', sendMsgReply);
}

async function openMsgThread(id, url, name) {
  msgCurrentId = id;
  const listPanel   = document.getElementById('msg-list-panel');
  const threadPanel = document.getElementById('msg-thread-panel');
  const threadName  = document.getElementById('msg-thread-name');
  const threadLink  = document.getElementById('msg-thread-link');
  const threadBody  = document.getElementById('msg-thread-body');
  const draftLabel  = document.getElementById('msg-draft-label');
  const textarea    = document.getElementById('msg-reply-textarea');

  if (!threadPanel) return;
  listPanel.style.display  = 'none';
  threadPanel.style.display = '';
  threadName.textContent   = name;
  threadLink.href          = url;
  threadBody.innerHTML     = '<div class="msg-thread-loading">Lädt…</div>';
  if (draftLabel) draftLabel.textContent = '';
  if (textarea)   textarea.value = '';

  try {
    const res = await fetch(`/proxy/messages/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // Render thread messages
    if (data.messages && data.messages.length > 0) {
      threadBody.innerHTML = data.messages.map(msg =>
        `<div class="msg-bubble ${msg.own ? 'msg-bubble--own' : 'msg-bubble--other'}">
          <div class="msg-bubble-text">${msgEscapeHtml(msg.text)}</div>
          ${msg.date ? `<div class="msg-bubble-date">${msgEscapeHtml(msg.date)}</div>` : ''}
        </div>`
      ).join('');
    } else {
      threadBody.innerHTML = '<p class="notif-empty">Keine Nachrichten geladen.</p>';
    }
    threadBody.scrollTop = threadBody.scrollHeight;

    // AI-Entwurf laden falls vorhanden
    if (data.draft) {
      if (textarea) textarea.value = data.draft;
      if (draftLabel) draftLabel.textContent = '✨ KI-Entwurf';
    }
  } catch (err) {
    threadBody.innerHTML = `<p class="notif-empty" style="color:var(--pink)">Fehler: ${msgEscapeHtml(err.message)}</p>`;
  }
}

async function sendMsgReply() {
  if (!msgCurrentId) return;
  const textarea = document.getElementById('msg-reply-textarea');
  const sendBtn  = document.getElementById('msg-reply-send');
  const label    = document.getElementById('msg-draft-label');
  const text     = textarea?.value?.trim();
  if (!text) return;

  const item = msgAllItems.find(i => i.id === msgCurrentId);
  if (!item) return;

  sendBtn.disabled    = true;
  sendBtn.textContent = '⏳ Sende…';

  try {
    const res = await fetch('/proxy/messages/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: item.url, text }),
      signal:  AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    textarea.value          = '';
    if (label) label.textContent = '✓ Gesendet';
    sendBtn.textContent     = '✓ Gesendet';
    setTimeout(() => {
      sendBtn.textContent = 'Senden ✉';
      sendBtn.disabled    = false;
      if (label) label.textContent = '';
    }, 2500);

    // Refresh thread
    const threadBody = document.getElementById('msg-thread-body');
    if (threadBody) {
      threadBody.innerHTML += `<div class="msg-bubble msg-bubble--own">
        <div class="msg-bubble-text">${msgEscapeHtml(text)}</div>
        <div class="msg-bubble-date">Jetzt</div>
      </div>`;
      threadBody.scrollTop = threadBody.scrollHeight;
    }
  } catch (err) {
    sendBtn.disabled    = false;
    sendBtn.textContent = '✗ Fehler: ' + err.message.substring(0, 30);
    setTimeout(() => {
      sendBtn.textContent = 'Senden ✉';
    }, 3000);
  }
}
