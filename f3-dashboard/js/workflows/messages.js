// Workflow-Karte: JOYclub ClubMail – Overlay

const MSG_PAGE_SIZE = 50;
let msgAllItems    = [];
let msgShownCount  = 0;
let msgTotalCount  = 0;
let msgCurrentId   = null;
let msgSearchQuery = '';
let msgMediaRecorder = null;
let msgAudioChunks   = [];
let msgPendingImage  = null; // { dataUrl, file } – noch nicht gesendet

// Häufige Emojis für den Picker
const MSG_EMOJIS = [
  '😊','😍','🥰','😘','😉','🤭','😏','😈','🔥','💥',
  '❤️','🖤','💜','💋','🍑','🍆','💦','✨','🎉','🥂',
  '👅','🤤','😮','😲','🙈','💃','🕺','🎭','🎪','🌙',
  '👋','🙏','💪','🤝','👍','💯','✔️','⚡','🎶','📍',
];

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
  // Doppelte Zeilenumbrüche → Absatz-Abstand, einfache → <br>
  s = s.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
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
          <button class="notif-refresh-btn" id="msg-refresh-btn" title="Neu laden">↺</button>
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
  document.getElementById('msg-refresh-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('msg-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      const data = await fetchMessagesData();
      const container = document.getElementById('section-messages')?.querySelector('.workflow-content');
      if (container) renderMessages(container, data);
    } catch(e) {
      if (btn) { btn.disabled = false; btn.textContent = '↺'; }
    }
  });

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
      <div id="msg-image-preview" style="display:none;padding:0.3rem 0.5rem;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:0.3rem;font-size:0.78rem;display:none;align-items:center;gap:0.5rem">
        <img id="msg-image-thumb" src="" style="height:40px;border-radius:3px">
        <span id="msg-image-name" style="color:var(--muted)"></span>
        <button onclick="msgClearImage()" style="background:none;border:none;color:var(--pink);cursor:pointer;font-size:1rem">✕</button>
      </div>
      <textarea class="msg-reply-textarea" id="msg-reply-textarea" placeholder="Antwort schreiben…" rows="4"></textarea>
      <div class="msg-reply-actions">
        <div class="msg-reply-media">
          <button class="msg-media-btn" id="msg-emoji-btn" title="Emoji">😊</button>
          <button class="msg-media-btn" id="msg-mic-btn" title="Sprache aufnehmen">🎤</button>
          <label class="msg-media-btn" title="Bild anhängen" style="cursor:pointer">📷<input type="file" id="msg-image-input" accept="image/*" style="display:none"></label>
        </div>
        <div id="msg-emoji-picker" style="display:none;position:absolute;bottom:3.5rem;left:0;background:var(--card,#1e1e2e);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:0.5rem;z-index:100;display:none;flex-wrap:wrap;gap:2px;width:280px;max-height:160px;overflow-y:auto">
          ${MSG_EMOJIS.map(e => `<button class="msg-emoji-item" data-emoji="${e}" style="background:none;border:none;font-size:1.3rem;cursor:pointer;padding:2px 4px;border-radius:4px;transition:background .1s" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='none'">${e}</button>`).join('')}
        </div>
        <span class="msg-draft-label" id="msg-draft-label"></span>
        <div class="msg-reply-right">
          <button class="msg-draft-btn" id="msg-draft-btn">✨ Vorschlag</button>
          <button class="msg-reply-send" id="msg-reply-send">Senden ✉</button>
        </div>
      </div>
    </div>`;

  document.getElementById('msg-reply-send')?.addEventListener('click', sendMsgReply);
  document.getElementById('msg-draft-btn')?.addEventListener('click', generateMsgDraft);
  document.getElementById('msg-reply-textarea')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsgReply(); }
  });

  // Emoji-Picker
  const emojiBtn = document.getElementById('msg-emoji-btn');
  const emojiPicker = document.getElementById('msg-emoji-picker');
  emojiBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const visible = emojiPicker.style.display === 'flex';
    emojiPicker.style.display = visible ? 'none' : 'flex';
  });
  emojiPicker?.querySelectorAll('.msg-emoji-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const ta = document.getElementById('msg-reply-textarea');
      if (ta) {
        const pos = ta.selectionStart;
        ta.value = ta.value.slice(0, pos) + btn.dataset.emoji + ta.value.slice(pos);
        ta.selectionStart = ta.selectionEnd = pos + btn.dataset.emoji.length;
        ta.focus();
      }
      emojiPicker.style.display = 'none';
    });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#msg-emoji-btn') && !e.target.closest('#msg-emoji-picker')) {
      if (emojiPicker) emojiPicker.style.display = 'none';
    }
  }, { once: false });

  // Mikrofon / Transkription
  document.getElementById('msg-mic-btn')?.addEventListener('click', toggleMsgRecording);

  // Bild-Upload via Datei-Input
  document.getElementById('msg-image-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) msgHandleImageFile(file);
  });

  // Drag & Drop auf Reply-Box
  const replyBox = thread.querySelector('.msg-reply-box');
  if (replyBox) {
    replyBox.addEventListener('dragover', e => { e.preventDefault(); replyBox.style.outline = '2px dashed var(--accent,#c074e8)'; });
    replyBox.addEventListener('dragleave', () => { replyBox.style.outline = ''; });
    replyBox.addEventListener('drop', e => {
      e.preventDefault(); replyBox.style.outline = '';
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) msgHandleImageFile(file);
    });
  }

  try {
    const threadUrl = `/proxy/messages/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}&url=${encodeURIComponent(url)}`;
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
      body.innerHTML = `<p class="notif-empty">Keine Nachrichten geladen.</p>`;
    }
    body.scrollTop = body.scrollHeight;

    // Kompliment-Nachrichten → automatisch als gelesen markieren
    const hasKompliment = (data.messages || []).some(m => m.isKompliment);
    if (hasKompliment) {
      const listItem = msgAllItems.find(i => i.id === id);
      fetch('/proxy/messages/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convId: id, convUrl: listItem?.url }),
        signal: AbortSignal.timeout(20000),
      }).catch(() => {});
    }

    // Draft nicht auto-befüllen – nur via Vorschlag-Button (manuell)
  } catch(err) {
    const body = document.getElementById('msg-thread-body');
    if (body) body.innerHTML = `<p class="notif-empty" style="color:var(--pink)">Fehler: ${msgEscape(err.message)}</p>`;
  }
}

async function generateMsgDraft() {
  if (!msgCurrentId) return;
  const item = msgAllItems.find(i => i.id === msgCurrentId);
  if (!item) return;

  const btn   = document.getElementById('msg-draft-btn');
  const label = document.getElementById('msg-draft-label');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generiere…'; }
  if (label) label.textContent = '';

  try {
    const res = await fetch('/api/generate-draft', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: item.name }),
      signal:  AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    if (data.draft) {
      const ta = document.getElementById('msg-reply-textarea');
      if (ta) ta.value = data.draft;
      if (label) label.textContent = '✨ KI-Entwurf';
    } else {
      if (label) label.textContent = '✗ ' + (data.error || 'Kein Entwurf');
    }
  } catch(err) {
    if (label) label.textContent = '✗ ' + err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Vorschlag'; }
  }
}

// ── Mikrofon / Transkription ──────────────────────────────────────────────────

async function toggleMsgRecording() {
  const btn = document.getElementById('msg-mic-btn');
  const label = document.getElementById('msg-draft-label');

  if (msgMediaRecorder && msgMediaRecorder.state === 'recording') {
    // Aufnahme stoppen
    msgMediaRecorder.stop();
    if (btn) { btn.textContent = '🎤'; btn.style.color = ''; }
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    msgAudioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    msgMediaRecorder = new MediaRecorder(stream, { mimeType });

    msgMediaRecorder.ondataavailable = e => { if (e.data.size > 0) msgAudioChunks.push(e.data); };
    msgMediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(msgAudioChunks, { type: mimeType });
      if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
      if (label) label.textContent = '⏳ Transkribiere…';
      try {
        const base64 = await new Promise((res2, rej2) => {
          const fr = new FileReader();
          fr.onload = () => res2(fr.result.split(',')[1]);
          fr.onerror = rej2;
          fr.readAsDataURL(blob);
        });
        const resp = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, mimeType }),
          signal: AbortSignal.timeout(35000),
        });
        const data = await resp.json();
        if (data.text) {
          const ta = document.getElementById('msg-reply-textarea');
          if (ta) ta.value = (ta.value ? ta.value + ' ' : '') + data.text;
          if (label) label.textContent = '🎤 Transkribiert';
        } else {
          if (label) label.textContent = '✗ ' + (data.error || 'Fehler');
        }
      } catch(err) {
        if (label) label.textContent = '✗ ' + err.message;
      } finally {
        if (btn) { btn.textContent = '🎤'; btn.disabled = false; btn.style.color = ''; }
        setTimeout(() => { const l = document.getElementById('msg-draft-label'); if (l && l.textContent.startsWith('🎤')) l.textContent = ''; }, 3000);
      }
    };

    msgMediaRecorder.start();
    if (btn) { btn.textContent = '⏹'; btn.style.color = '#e85656'; }
    if (label) label.textContent = '● Aufnahme läuft…';
  } catch(err) {
    if (label) label.textContent = '✗ Mikrofon: ' + err.message;
  }
}

// ── Bild-Upload ───────────────────────────────────────────────────────────────

function msgHandleImageFile(file) {
  msgPendingImage = { file };
  const reader = new FileReader();
  reader.onload = e => {
    msgPendingImage.dataUrl = e.target.result;
    const preview = document.getElementById('msg-image-preview');
    const thumb   = document.getElementById('msg-image-thumb');
    const nameEl  = document.getElementById('msg-image-name');
    if (preview) { preview.style.display = 'flex'; }
    if (thumb)   { thumb.src = e.target.result; }
    if (nameEl)  { nameEl.textContent = file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)'; }
  };
  reader.readAsDataURL(file);
}

function msgClearImage() {
  msgPendingImage = null;
  const preview = document.getElementById('msg-image-preview');
  if (preview) preview.style.display = 'none';
  const input = document.getElementById('msg-image-input');
  if (input) input.value = '';
}

async function sendMsgReply() {
  if (!msgCurrentId) return;
  const textarea = document.getElementById('msg-reply-textarea');
  const sendBtn  = document.getElementById('msg-reply-send');
  const label    = document.getElementById('msg-draft-label');
  const text     = textarea?.value?.trim();
  if (!text && !msgPendingImage) return;

  const item = msgAllItems.find(i => i.id === msgCurrentId);
  if (!item) return;

  sendBtn.disabled    = true;
  sendBtn.textContent = '⏳ Sende…';

  try {
    if (text) {
      const res = await fetch('/proxy/messages/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: item.name, url: item.url, text }),
        signal:  AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    }

    const threadBody = document.getElementById('msg-thread-body');
    if (threadBody) {
      if (text) {
        threadBody.innerHTML += `<div class="msg-bubble msg-bubble--own">
          <div class="msg-bubble-text">${msgEscape(text)}</div>
          <div class="msg-bubble-date">Jetzt</div>
        </div>`;
      }
      if (msgPendingImage?.dataUrl) {
        threadBody.innerHTML += `<div class="msg-bubble msg-bubble--own">
          <img src="${msgPendingImage.dataUrl}" style="max-width:180px;border-radius:6px;display:block">
          <div class="msg-bubble-date">Jetzt · Nur lokal sichtbar</div>
        </div>`;
      }
      threadBody.scrollTop = threadBody.scrollHeight;
    }

    textarea.value = '';
    msgClearImage();
    if (label) label.textContent = '✓ Gesendet';
    sendBtn.textContent = '✓ Gesendet';
    setTimeout(() => { sendBtn.textContent = 'Senden ✉'; sendBtn.disabled = false; if (label) label.textContent = ''; }, 2500);
  } catch(err) {
    sendBtn.disabled    = false;
    sendBtn.textContent = '✗ Fehler';
    setTimeout(() => { sendBtn.textContent = 'Senden ✉'; }, 3000);
  }
}
