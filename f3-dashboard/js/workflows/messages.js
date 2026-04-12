// Workflow-Karte: JOYclub ClubMail – Overlay

const MSG_PAGE_SIZE = 50;
let msgAllItems    = [];
let msgShownCount  = 0;
let msgTotalCount  = 0;
let msgCurrentId   = null;
let msgSearchQuery = '';
let msgDebugInfo   = null;

function msgEscape(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Text mit [LINK:url:text] Platzhaltern und \n zu HTML umwandeln
function msgFormatText(str) {
  if (!str) return '';
  // Zuerst escapen
  let s = msgEscape(str);
  // **text** → <strong>
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // [LINK:url:text] → <a>
  s = s.replace(/\[LINK:([^\]]*?):([^\]]*?)\]/g, (_, href, text) => {
    const h = href.trim();
    const t = text.trim() || h;
    if (!h) return msgEscape(t);
    // Relative URLs ergänzen
    const fullHref = h.startsWith('http') ? h : ('https://www.joyclub.de' + h);
    return `<a href="${fullHref}" target="_blank" rel="noopener" class="msg-link">${t || fullHref}</a>`;
  });
  // Zeilenumbrüche
  s = s.replace(/\n/g, '<br>');
  return s;
}

async function fetchMessagesData() {
  const res = await fetch('/proxy/messages', { signal: AbortSignal.timeout(85000) });
  if (!res.ok) throw new Error(`Messages ${res.status}`);
  return res.json();
}

function renderMessages(container, data) {
  const badge = document.getElementById('section-messages-badge');
  const setBadge = (cls, icon, text) => {
    if (!badge) return;
    badge.className = `wf-status-badge ${cls}`;
    badge.querySelector('.wf-status-icon').textContent = icon;
    badge.querySelector('.wf-status-text').textContent = text;
  };

  if (data.error) {
    setBadge('status-error','✗','Fehler');
    container.innerHTML = `<p class="notif-empty" style="color:var(--pink)">${msgEscape(data.error)}</p>`;
    return;
  }
  if (data.loggedOut) {
    setBadge('status-error','✗','Ausgeloggt');
    container.innerHTML = '<p class="notif-empty">Nicht eingeloggt.</p>';
    return;
  }

  msgAllItems   = data.items || [];
  msgTotalCount = data.totalCount || 0;
  msgShownCount = Math.min(MSG_PAGE_SIZE, msgAllItems.length);
  msgDebugInfo  = data.debugInfo || null;

  if (msgTotalCount > 0) {
    setBadge('status-warn', msgTotalCount > 99 ? '99+' : String(msgTotalCount), `${msgTotalCount} neu`);
  } else {
    setBadge('status-ok','✓','Keine neuen');
  }

  // Header-Badge
  const hBadge = document.getElementById('badge-mail-count');
  if (hBadge) hBadge.textContent = msgTotalCount > 0 ? (msgTotalCount > 99 ? '99+' : msgTotalCount) : '';
  const nBadge = document.getElementById('nav-count-messages');
  if (nBadge) {
    nBadge.textContent  = msgTotalCount > 0 ? (msgTotalCount > 99 ? '99+' : msgTotalCount) : '';
    nBadge.style.display = msgTotalCount > 0 ? '' : 'none';
  }

  const fetchedAt = data.fetchedAt
    ? new Date(data.fetchedAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})
    : '';

  // Thread-Inhalt retten (falls Gespräch offen ist)
  const savedThread = msgCurrentId ? document.getElementById('msg-split-thread')?.innerHTML : null;

  // Layout immer frisch aufbauen (verhindert kaputten Zustand nach Fehler)
  container.innerHTML = `
    <div class="msg-split">
      <div class="msg-split-list" id="msg-split-list">
        <div class="msg-search-wrap">
          <input class="msg-search-input" id="msg-search" type="text" placeholder="Suchen…" autocomplete="off" value="${msgSearchQuery.replace(/"/g,'&quot;')}">
        </div>
        <div class="notif-toolbar">
          <span class="notif-fetched-at">${fetchedAt ? 'Abgerufen: ' + fetchedAt : ''}</span>
        </div>
        <div class="msg-list" id="msg-list"></div>
        <div class="notif-footer">
          <span class="notif-count-info" id="msg-count-info"></span>
          <button class="notif-load-more" id="msg-load-more" style="display:none">Mehr →</button>
        </div>
      </div>
      <div class="msg-split-thread" id="msg-split-thread">
        <div class="msg-thread-placeholder"><span>← Gespräch auswählen</span></div>
      </div>
    </div>`;

  // Thread wiederherstellen
  if (savedThread) {
    const threadEl = document.getElementById('msg-split-thread');
    if (threadEl) {
      threadEl.innerHTML = savedThread;
      document.getElementById('msg-reply-send')?.addEventListener('click', sendMsgReply);
    }
  }

  bindMsgEvents();

  renderMsgList();
}

function renderMsgList() {
  const list = document.getElementById('msg-list');
  const info = document.getElementById('msg-count-info');
  const more = document.getElementById('msg-load-more');
  if (!list) return;

  const q = msgSearchQuery.toLowerCase().trim();
  const filtered = q
    ? msgAllItems.filter(i => i.name.toLowerCase().includes(q) || (i.preview||'').toLowerCase().includes(q))
    : msgAllItems;
  const visible = filtered.slice(0, msgShownCount);
  if (!visible.length) {
    list.innerHTML = '<p class="notif-empty">Keine Nachrichten vorhanden.</p>';
    if (info) info.textContent = '';
    if (more) more.style.display = 'none';
    return;
  }

  list.innerHTML = visible.map(item => {
    const avatarHtml = item.avatar
      ? `<img class="msg-avatar" src="${msgEscape(item.avatar)}" alt="" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<span class="msg-avatar msg-avatar--fallback" style="display:none">👤</span>`
      : `<span class="msg-avatar msg-avatar--fallback">👤</span>`;

    const unreadBadge = item.unread
      ? `<span class="msg-unread-badge">${item.unreadN > 0 ? item.unreadN : ''}</span>`
      : '';

    const genderIcon = item.gender
      ? `<span class="msg-gender-icon msg-gender-icon--${msgEscape(item.gender.toLowerCase())}" title="${msgEscape(item.gender)}"></span>`
      : '';

    return `<div class="msg-item${item.unread ? ' msg-item--unread' : ''}${msgCurrentId === item.id ? ' msg-item--active' : ''}"
         data-msg-id="${msgEscape(item.id)}"
         data-msg-url="${msgEscape(item.url)}"
         data-msg-name="${msgEscape(item.name)}">
      <div class="msg-item-avatar-wrap">
        ${avatarHtml}
        ${unreadBadge}
      </div>
      <div class="msg-item-body">
        <div class="msg-item-row1">
          <span class="msg-item-name">${msgEscape(item.name)}</span>${genderIcon}
          ${item.date ? `<span class="msg-item-date">${msgEscape(item.date)}</span>` : ''}
        </div>
        ${item.preview ? `<div class="msg-item-preview">${msgEscape(item.preview)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  if (info) info.textContent = q ? `${visible.length} Treffer` : (filtered.length < msgAllItems.length ? `${visible.length} von ${msgAllItems.length}` : `${msgAllItems.length} Gespräche`);
  if (more) more.style.display = msgShownCount < filtered.length ? '' : 'none';
}

function bindMsgEvents() {
  document.getElementById('msg-search')?.addEventListener('input', e => {
    msgSearchQuery = e.target.value;
    msgShownCount  = MSG_PAGE_SIZE;
    renderMsgList();
  });

  document.getElementById('msg-load-more')?.addEventListener('click', () => {
    msgShownCount = Math.min(msgShownCount + MSG_PAGE_SIZE, msgAllItems.length);
    renderMsgList();
  });

  document.getElementById('msg-list')?.addEventListener('click', e => {
    const item = e.target.closest('.msg-item');
    if (!item) return;
    openMsgThread(item.dataset.msgId, item.dataset.msgUrl, item.dataset.msgName);
  });
}

async function openMsgThread(id, url, name) {
  msgCurrentId = id;
  renderMsgList(); // aktives Item markieren

  const thread = document.getElementById('msg-split-thread');
  if (!thread) return;

  thread.innerHTML = `
    <div class="msg-thread-header">
      <span class="msg-thread-name">${msgEscape(name)}</span>
      <a class="msg-thread-link" href="${msgEscape(url)}" target="_blank" rel="noopener">↗ JOYclub</a>
    </div>
    <div class="msg-thread-body" id="msg-thread-body">
      <div class="msg-thread-loading">Lädt…</div>
    </div>
    <div class="msg-reply-box">
      <textarea class="msg-reply-textarea" id="msg-reply-textarea" placeholder="Antwort schreiben…" rows="3"></textarea>
      <div class="msg-reply-actions">
        <span class="msg-draft-label" id="msg-draft-label"></span>
        <button class="msg-reply-send" id="msg-reply-send">Senden ✉</button>
      </div>
    </div>`;

  document.getElementById('msg-reply-send')?.addEventListener('click', sendMsgReply);

  try {
    const threadUrl = `/proxy/messages/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`;
    const res = await fetch(threadUrl, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const body = document.getElementById('msg-thread-body');
    if (!body) return;

    if (data.messages && data.messages.length > 0) {
      body.innerHTML = data.messages.map(msg => {
        const cls = msg.own ? 'msg-bubble--own' : (msg.isKompliment ? 'msg-bubble--other msg-bubble--kompliment' : 'msg-bubble--other');
        const senderHtml = (!msg.own && msg.sender) ? `<div class="msg-bubble-sender">${msgEscape(msg.sender)}</div>` : '';
        return `<div class="msg-bubble ${cls}">
          ${senderHtml}
          <div class="msg-bubble-text">${msgFormatText(msg.text)}</div>
          ${msg.date ? `<div class="msg-bubble-date">${msgEscape(msg.date)}</div>` : ''}
        </div>`;
      }).join('');
    } else {
      const di = data.debugInfo;
      const debugHtml = di ? `<pre style="font-size:0.6rem;color:rgba(255,255,255,0.3);white-space:pre-wrap;max-height:200px;overflow:auto">${msgEscape('click:' + di.click + ' | threadUrl:' + di.threadUrl + ' | path:' + di.path + '\ne2e:' + (di.e2e||[]).join(','))}</pre>` : '';
      body.innerHTML = `<p class="notif-empty">Keine Nachrichten geladen.</p>${debugHtml}`;
    }
    body.scrollTop = body.scrollHeight;

    if (data.draft) {
      const ta = document.getElementById('msg-reply-textarea');
      const dl = document.getElementById('msg-draft-label');
      if (ta) ta.value = data.draft;
      if (dl) dl.textContent = '✨ KI-Entwurf';
    }
  } catch(err) {
    const body = document.getElementById('msg-thread-body');
    if (body) body.innerHTML = `<p class="notif-empty" style="color:var(--pink)">Fehler: ${msgEscape(err.message)}</p>`;
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
      body:    JSON.stringify({ name: item.name, url: item.url, text }),
      signal:  AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    textarea.value = '';
    if (label) label.textContent = '✓ Gesendet';
    sendBtn.textContent = '✓ Gesendet';

    const body = document.getElementById('msg-thread-body');
    if (body) {
      body.innerHTML += `<div class="msg-bubble msg-bubble--own">
        <div class="msg-bubble-text">${msgEscape(text)}</div>
        <div class="msg-bubble-date">Jetzt</div>
      </div>`;
      body.scrollTop = body.scrollHeight;
    }
    setTimeout(() => { sendBtn.textContent = 'Senden ✉'; sendBtn.disabled = false; if (label) label.textContent = ''; }, 2500);
  } catch(err) {
    sendBtn.disabled    = false;
    sendBtn.textContent = '✗ Fehler';
    setTimeout(() => { sendBtn.textContent = 'Senden ✉'; }, 3000);
  }
}
