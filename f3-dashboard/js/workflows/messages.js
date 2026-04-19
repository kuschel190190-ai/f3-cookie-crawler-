// Workflow-Karte: JOYclub ClubMail – Overlay

const MSG_PAGE_SIZE = 50;
let msgAllItems       = [];
let msgShownCount     = 0;
let msgTotalCount     = 0;
let msgCurrentId      = null;
let msgCurrentName    = null;
let msgCurrentUrl     = null;
let msgCurrentMessages = []; // geladene Nachrichten des aktuellen Threads (für Vorschlag)
let msgSearchQuery    = '';
let msgUnreadOnly     = false; // Filter: nur Ungelesene anzeigen

// Einmalig: Emoji-Picker schließen bei Klick außerhalb
document.addEventListener('click', e => {
  if (!e.target.closest('#msg-emoji-btn') && !e.target.closest('#msg-emoji-picker')) {
    const p = document.getElementById('msg-emoji-picker');
    if (p && p.style.display === 'flex') p.style.display = 'none';
  }
});
let msgMediaRecorder = null;
let msgAudioChunks   = [];
let msgPendingImage  = null; // { dataUrl, file } – noch nicht gesendet
let msgAutoReplies   = []; // Auto-Reply-Verlauf vom Server
let msgAutoReplyOpen = null; // aktuell angezeigte Entry-ID im Auto-Reply-Panel

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
    <div class="msg-auto-section" id="msg-auto-section">
      <div class="msg-auto-header" id="msg-auto-toggle">
        <span>&#x1F916; Automatische Antworten</span>
        <span class="msg-auto-count" id="msg-auto-count"></span>
        <span class="msg-auto-chevron" id="msg-auto-chevron">&#9660;</span>
      </div>
      <div class="msg-auto-body" id="msg-auto-body" style="display:none">
        <div class="msg-auto-split">
          <div class="msg-auto-list" id="msg-auto-list"><p class="notif-empty">Lädt…</p></div>
          <div class="msg-auto-thread" id="msg-auto-thread"><span class="msg-auto-placeholder">&#8592; Eintrag auswählen</span></div>
        </div>
      </div>
    </div>
    <div class="msg-split">
      <div class="msg-split-list" id="msg-split-list">
        <div class="msg-search-wrap">
          <input class="msg-search-input" id="msg-search" type="text" placeholder="Suchen…" autocomplete="off" value="${msgSearchQuery.replace(/"/g,'&quot;')}">
        </div>
        <div class="notif-toolbar">
          <span class="notif-fetched-at">${fetchedAt ? 'Abgerufen: ' + fetchedAt : ''}</span>
          <div class="msg-filter-btns">
            <button class="msg-filter-btn${msgUnreadOnly ? '' : ' active'}" id="msg-filter-all">Alle</button>
            <button class="msg-filter-btn${msgUnreadOnly ? ' active' : ''}" id="msg-filter-unread">Ungelesen</button>
          </div>
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

  // Thread wiederherstellen + alle Events neu binden
  if (savedThread) {
    const threadEl = document.getElementById('msg-split-thread');
    if (threadEl) {
      threadEl.innerHTML = savedThread;
      rewireThreadEvents();
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
  const baseItems = msgUnreadOnly ? msgAllItems.filter(i => i.unread) : msgAllItems;
  const filtered = q
    ? baseItems.filter(i => i.name.toLowerCase().includes(q) || (i.preview||'').toLowerCase().includes(q))
    : baseItems;
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
  // Auto-Reply Panel: Toggle + Daten laden
  document.getElementById('msg-auto-toggle')?.addEventListener('click', () => {
    const body = document.getElementById('msg-auto-body');
    const chevron = document.getElementById('msg-auto-chevron');
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    if (chevron) chevron.innerHTML = open ? '&#9660;' : '&#9650;';
    if (!open) loadAutoReplyPanel();
  });

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

  document.getElementById('msg-filter-all')?.addEventListener('click', () => {
    msgUnreadOnly = false;
    msgShownCount = MSG_PAGE_SIZE;
    document.getElementById('msg-filter-all')?.classList.add('active');
    document.getElementById('msg-filter-unread')?.classList.remove('active');
    renderMsgList();
  });
  document.getElementById('msg-filter-unread')?.addEventListener('click', () => {
    msgUnreadOnly = true;
    msgShownCount = MSG_PAGE_SIZE;
    document.getElementById('msg-filter-unread')?.classList.add('active');
    document.getElementById('msg-filter-all')?.classList.remove('active');
    renderMsgList();
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

// ── Thread-Events verdrahten (nach jedem HTML-Rebuild aufrufen) ───────────────
function rewireThreadEvents() {
  const thread = document.getElementById('msg-split-thread');
  if (!thread) return;

  document.getElementById('msg-reply-send')?.addEventListener('click', sendMsgReply);
  document.getElementById('msg-draft-btn')?.addEventListener('click', generateMsgDraft);
  document.getElementById('msg-reply-textarea')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsgReply(); }
  });

  // Emoji-Picker – position:fixed, koordinaten beim Öffnen setzen
  const emojiBtn    = document.getElementById('msg-emoji-btn');
  const emojiPicker = document.getElementById('msg-emoji-picker');
  emojiBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const visible = emojiPicker?.style.display === 'flex';
    if (emojiPicker) {
      if (!visible) {
        const r = emojiBtn.getBoundingClientRect();
        emojiPicker.style.left   = Math.min(r.left, window.innerWidth - 290) + 'px';
        emojiPicker.style.top    = (r.top - 174) + 'px';
        emojiPicker.style.bottom = 'auto';
      }
      emojiPicker.style.display = visible ? 'none' : 'flex';
    }
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
      if (emojiPicker) emojiPicker.style.display = 'none';
    });
  });

  // Mikrofon
  document.getElementById('msg-mic-btn')?.addEventListener('click', toggleMsgRecording);

  // Bild-Upload
  document.getElementById('msg-image-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) msgHandleImageFile(file);
  });

  // Drag & Drop
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
}

async function openMsgThread(id, url, name) {
  msgCurrentId   = id;
  msgCurrentName = name;
  msgCurrentUrl  = url;
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
      <div id="msg-image-preview" style="display:none;padding:0.3rem 0.5rem;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:0.3rem;font-size:0.78rem;align-items:center;gap:0.5rem">
        <img id="msg-image-thumb" src="" style="height:40px;border-radius:3px">
        <span id="msg-image-name" style="color:var(--muted)"></span>
        <button onclick="msgClearImage()" style="background:none;border:none;color:var(--pink);cursor:pointer;font-size:1rem">✕</button>
      </div>
      <textarea class="msg-reply-textarea" id="msg-reply-textarea" placeholder="Antwort schreiben…" rows="4"></textarea>
      <div class="msg-reply-actions">
        <div class="msg-reply-media">
          <button class="msg-media-btn" id="msg-emoji-btn" title="Emoji">&#x1F60A;</button>
          <button class="msg-media-btn msg-media-btn--text" id="msg-mic-btn" title="Sprache aufnehmen">&#9679; Ton</button>
          <label class="msg-media-btn msg-media-btn--text" title="Bild anhängen" style="cursor:pointer">&#8593; Foto<input type="file" id="msg-image-input" accept="image/*" style="display:none"></label>
        </div>
        <div id="msg-emoji-picker" style="position:fixed;display:none;background:var(--card,#1e1e2e);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:0.5rem;z-index:9999;flex-wrap:wrap;gap:2px;width:280px;max-height:160px;overflow-y:auto;box-shadow:0 4px 20px rgba(0,0,0,0.5)">
          ${MSG_EMOJIS.map(e => `<button class="msg-emoji-item" data-emoji="${e}" style="background:none;border:none;font-size:1.3rem;cursor:pointer;padding:2px 4px;border-radius:4px;transition:background .1s" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='none'">${e}</button>`).join('')}
        </div>
        <span class="msg-draft-label" id="msg-draft-label"></span>
        <div class="msg-reply-right">
          <button class="msg-draft-btn" id="msg-draft-btn">✨ Vorschlag</button>
          <button class="msg-reply-send" id="msg-reply-send">Senden ✉</button>
        </div>
      </div>
    </div>`;

  rewireThreadEvents();

  try {
    const threadUrl = `/proxy/messages/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}&url=${encodeURIComponent(url)}`;
    const res = await fetch(threadUrl, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const body = document.getElementById('msg-thread-body');
    if (!body) return;

    msgCurrentMessages = data.messages || []; // für Vorschlag/generate-draft

    if (data.messages && data.messages.length > 0) {
      body.innerHTML = data.messages.map(msg => {
        const cls = msg.own ? 'msg-bubble--own' : (msg.isKompliment ? 'msg-bubble--other msg-bubble--kompliment' : 'msg-bubble--other');
        const senderHtml = (!msg.own && msg.sender) ? `<div class="msg-bubble-sender">${msgEscape(msg.sender)}</div>` : '';
        let contentHtml;
        if (msg.isImage && msg.imageUrl) {
          // data: URLs (blob-konvertiert) direkt nutzen, http: URLs über proxy
          const imgSrc = msg.imageUrl.startsWith('data:')
            ? msg.imageUrl
            : '/api/proxy-image?url=' + encodeURIComponent(msg.imageUrl);
          contentHtml = `<div class="msg-bubble-img-wrap">
            <img src="${imgSrc}" class="msg-bubble-img" loading="lazy"
              onerror="this.closest('.msg-bubble-img-wrap').innerHTML='<span class=msg-bubble-photo-fallback>📷 Foto</span>'">
          </div>`;
        } else if (msg.isImage) {
          contentHtml = `<div class="msg-bubble-text"><span class="msg-bubble-photo-fallback">📷 Foto</span></div>`;
        } else {
          contentHtml = `<div class="msg-bubble-text">${msgFormatText(msg.text)}</div>`;
        }
        return `<div class="msg-bubble ${cls}">
          ${senderHtml}
          ${contentHtml}
          ${msg.date ? `<div class="msg-bubble-date">${msgEscape(msg.date)}</div>` : ''}
        </div>`;
      }).join('');
    } else {
      body.innerHTML = `<p class="notif-empty">Keine Nachrichten geladen.</p>`;
    }
    body.scrollTop = body.scrollHeight;

    // Als gelesen markieren: lokal + JOYclub (via CDP wenn Kompliment, sonst reicht CDP-Navigation aus Thread-Load)
    const listItem = msgAllItems.find(i => i.id === id);
    const hasKompliment = (data.messages || []).some(m => m.isKompliment);
    if (listItem && listItem.unread) {
      // Lokal als gelesen markieren
      listItem.unread = false;
      listItem.unreadN = 0;
      renderMsgList();
      // Badge aktualisieren
      const badge = document.getElementById('section-messages-badge');
      const remaining = msgAllItems.filter(i => i.unread).length;
      if (badge) {
        if (remaining > 0) {
          badge.className = 'wf-status-badge status-warn';
          badge.querySelector('.wf-status-icon').textContent = remaining > 99 ? '99+' : String(remaining);
          badge.querySelector('.wf-status-text').textContent = `${remaining} neu`;
        } else {
          badge.className = 'wf-status-badge status-ok';
          badge.querySelector('.wf-status-icon').textContent = '✓';
          badge.querySelector('.wf-status-text').textContent = 'Keine neuen';
        }
      }
    }
    if (hasKompliment) {
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
      // Nachrichten mitsenden → server überspringt zweiten CDP-Fetch
      body:    JSON.stringify({ name: item.name, url: item.url, messages: msgCurrentMessages }),
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
    if (btn) { btn.innerHTML = '&#9679; Ton'; btn.style.color = ''; }
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
          if (label) label.textContent = 'Transkribiert ✓';
        } else {
          if (label) label.textContent = '✗ ' + (data.error || 'Fehler');
        }
      } catch(err) {
        if (label) label.textContent = '✗ ' + err.message;
      } finally {
        if (btn) { btn.innerHTML = '&#9679; Ton'; btn.disabled = false; btn.style.color = ''; }
        setTimeout(() => { const l = document.getElementById('msg-draft-label'); if (l && l.textContent.startsWith('Transkribiert')) l.textContent = ''; }, 3000);
      }
    };

    msgMediaRecorder.start();
    if (btn) { btn.innerHTML = '&#9209; Stop'; btn.style.color = '#e85656'; }
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

// ── Automatische Antworten Panel ─────────────────────────────────────────────

async function loadAutoReplyPanel() {
  try {
    const res = await fetch('/api/auto-reply-log', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    msgAutoReplies = data.log || [];
    renderAutoReplyList();
  } catch(e) {
    const list = document.getElementById('msg-auto-list');
    if (list) list.innerHTML = `<p class="notif-empty" style="color:var(--muted)">Nicht verfügbar</p>`;
  }
}

function renderAutoReplyList() {
  const list = document.getElementById('msg-auto-list');
  const countEl = document.getElementById('msg-auto-count');
  if (!list) return;
  if (countEl) countEl.textContent = msgAutoReplies.length ? `(${msgAutoReplies.length})` : '';
  if (!msgAutoReplies.length) {
    list.innerHTML = '<p class="notif-empty">Noch keine automatischen Antworten.</p>';
    return;
  }
  // Group by name: count per person
  const counts = {};
  for (const e of msgAutoReplies) counts[e.name] = (counts[e.name] || 0) + 1;
  list.innerHTML = msgAutoReplies.map(entry => {
    const d = entry.sentAt ? new Date(entry.sentAt) : null;
    const timeStr = d ? d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'}) + ' ' + d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}) : '';
    const isActive = msgAutoReplyOpen === entry.id;
    return `<div class="msg-auto-entry${isActive ? ' msg-auto-entry--active' : ''}" data-auto-id="${entry.id}" data-auto-name="${msgEscape(entry.name)}" data-auto-conv-id="${msgEscape(entry.convId||'')}" data-auto-conv-url="${msgEscape(entry.convUrl||'')}">
      <div class="msg-auto-entry-name">${msgEscape(entry.name)}</div>
      <div class="msg-auto-entry-meta">
        <span class="msg-auto-entry-type">${entry.type === 'warteliste_no_photo' ? 'Warteliste (kein Foto)' : msgEscape(entry.type||'')}</span>
        ${timeStr ? `<span class="msg-auto-entry-time">${timeStr}</span>` : ''}
        ${counts[entry.name] > 1 ? `<span class="msg-auto-entry-count">${counts[entry.name]}x</span>` : ''}
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.msg-auto-entry').forEach(el => {
    el.addEventListener('click', () => {
      msgAutoReplyOpen = Number(el.dataset.autoId);
      renderAutoReplyList();
      openAutoReplyThread(el.dataset.autoName, el.dataset.autoConvId, el.dataset.autoConvUrl);
    });
  });
}

let _autoThreadShowAll = false;
async function openAutoReplyThread(name, convId, convUrl) {
  _autoThreadShowAll = false;
  const panel = document.getElementById('msg-auto-thread');
  if (!panel) return;
  panel.innerHTML = `<p class="notif-empty">Lädt…</p>`;
  try {
    const threadUrl = `/proxy/messages/${encodeURIComponent(convId)}?name=${encodeURIComponent(name)}&url=${encodeURIComponent(convUrl)}`;
    const res = await fetch(threadUrl, { signal: AbortSignal.timeout(40000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderAutoReplyThread(panel, name, data.messages || []);
  } catch(e) {
    panel.innerHTML = `<p class="notif-empty" style="color:var(--pink)">Fehler: ${msgEscape(e.message)}</p>`;
  }
}

function renderAutoReplyThread(panel, name, messages) {
  const MAX = 10;
  const total = messages.length;
  const shown = _autoThreadShowAll ? messages : messages.slice(-MAX);
  const hasMore = !_autoThreadShowAll && total > MAX;
  panel.innerHTML = `
    <div class="msg-auto-thread-header">${msgEscape(name)}</div>
    <div class="msg-auto-thread-body">
      ${hasMore ? `<button class="msg-auto-showmore" id="msg-auto-showmore">&#9650; ${total - MAX} ältere anzeigen</button>` : ''}
      ${shown.map(msg => {
        const cls = msg.own ? 'msg-bubble--own' : 'msg-bubble--other';
        let content;
        if (msg.isImage && msg.imageUrl) {
          const _pUrl = msg.imageUrl.startsWith('data:')
            ? msg.imageUrl
            : '/api/proxy-image?url=' + encodeURIComponent(msg.imageUrl);
          content = `<img src="${_pUrl}" style="max-width:180px;border-radius:6px;display:block" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'📷 Foto'}))">`;
        } else if (msg.isImage) {
          content = '📷 Foto';
        } else {
          content = msgFormatText(msg.text);
        }
        return `<div class="msg-bubble ${cls}" style="margin-bottom:4px">
          <div class="msg-bubble-text" style="font-size:0.82rem">${content}</div>
          ${msg.date ? `<div class="msg-bubble-date" style="font-size:0.7rem">${msgEscape(msg.date)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  panel.querySelector('#msg-auto-showmore')?.addEventListener('click', () => {
    _autoThreadShowAll = true;
    renderAutoReplyThread(panel, name, messages);
  });
  panel.querySelector('.msg-auto-thread-body').scrollTop = 99999;
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
    const payload = { name: item.name, url: item.url, text: text || '' };

    // Bild: dataUrl → base64 extrahieren und mitsenden
    if (msgPendingImage?.dataUrl) {
      const comma = msgPendingImage.dataUrl.indexOf(',');
      const header = msgPendingImage.dataUrl.substring(0, comma);
      const mimeMatch = header.match(/data:([^;]+)/);
      payload.imageBase64 = msgPendingImage.dataUrl.substring(comma + 1);
      payload.imageMimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      if (label) label.textContent = '⏳ Bild wird hochgeladen…';
    }

    const res = await fetch('/proxy/messages/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Senden fehlgeschlagen');

    // Lokale Vorschau im Thread
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
          <div class="msg-bubble-date">Jetzt</div>
        </div>`;
      }
      threadBody.scrollTop = threadBody.scrollHeight;
    }

    textarea.value = '';
    msgClearImage();
    if (label) label.textContent = '✓ Gesendet';
    sendBtn.textContent = '✓ Gesendet';
    setTimeout(() => { sendBtn.textContent = 'Senden ✉'; sendBtn.disabled = false; if (label) label.textContent = ''; }, 2500);

    // Cache invalidieren: Server lädt Messages-Liste beim nächsten Aufruf frisch
    fetch('/proxy/messages/refresh', { method: 'POST' }).catch(() => {});
    // Nach 3s die Messages-Liste im Hintergrund aktualisieren (zeigt gesendete Msg)
    setTimeout(() => {
      const container = document.getElementById('messages-container');
      if (container && typeof fetchMessagesData === 'function' && typeof renderMessages === 'function') {
        fetchMessagesData().then(d => renderMessages(container, d)).catch(() => {});
      }
    }, 3000);
  } catch(err) {
    sendBtn.disabled    = false;
    sendBtn.textContent = '✗ Fehler';
    if (label) label.textContent = '✗ ' + err.message;
    setTimeout(() => { sendBtn.textContent = 'Senden ✉'; if (label) label.textContent = ''; }, 4000);
  }
}
