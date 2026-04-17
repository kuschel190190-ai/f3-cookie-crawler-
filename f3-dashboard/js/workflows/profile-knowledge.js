// Profil-Homepages: gescrapte F3-Infoseiten (LV-Regeln, Hygiene, FFF-Unterschied)
// Quelle: n8n Homepage-Sektion → Status-Store profile-knowledge

async function fetchProfileKnowledge() {
  const res = await fetch('/proxy/profile-knowledge', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!json || typeof json !== 'object') return null;
  return json.data || null;
}

function renderProfileKnowledge(data) {
  const badge   = document.getElementById('badge-profile-knowledge');
  const content = document.getElementById('profile-knowledge-content');
  if (!badge || !content) return;

  if (!data || !data.pages || data.pages.length === 0) {
    badge.className = 'wf-status-badge status-warn';
    badge.querySelector('.wf-status-icon').textContent = '⚠';
    badge.querySelector('.wf-status-text').textContent = 'Nicht geladen';
    content.innerHTML = '<p style="color:var(--muted);font-size:0.82rem">'
      + 'Noch keine Daten – Homepage-Workflow ausführen (<code>f3-profile-knowledge</code>).</p>';
    return;
  }

  const ok = data.pages.filter(p => p.text && p.text.length > 50).length;
  badge.className = ok > 0 ? 'wf-status-badge status-ok' : 'wf-status-badge status-warn';
  badge.querySelector('.wf-status-icon').textContent = ok > 0 ? '✓' : '⚠';
  badge.querySelector('.wf-status-text').textContent = data.pages.length + ' Seiten';

  const ago = data.scrapedAt ? relativeTime(data.scrapedAt) : '—';

  content.innerHTML =
    '<div style="font-size:0.75rem;color:var(--muted);margin-bottom:0.5rem">Abgerufen: ' + ago + '</div>'
    + '<div style="display:flex;flex-direction:column;gap:0.3rem">'
    + data.pages.map(p => {
        const title = p.title || p.slug || p.url;
        const hasText = p.text && p.text.length > 50;
        return '<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.82rem">'
          + '<span style="color:' + (hasText ? '#4caf50' : '#e8a556') + '">' + (hasText ? '✓' : '⚠') + '</span>'
          + '<a href="' + p.url + '" target="_blank" rel="noopener" style="color:var(--accent,#c074e8);text-decoration:none;word-break:break-word">'
          + title + '</a>'
          + '</div>';
      }).join('')
    + '</div>';
}

async function refreshProfileKnowledge() {
  const card = document.getElementById('wf-profile-knowledge');
  if (!card) return;
  try {
    const data = await fetchProfileKnowledge();
    renderProfileKnowledge(data);
  } catch(e) {
    const badge = document.getElementById('badge-profile-knowledge');
    if (badge) {
      badge.className = 'wf-status-badge status-warn';
      badge.querySelector('.wf-status-icon').textContent = '⚠';
      badge.querySelector('.wf-status-text').textContent = 'Fehler';
    }
    const content = document.getElementById('profile-knowledge-content');
    if (content) content.innerHTML = '<p style="color:var(--muted);font-size:0.82rem">' + e.message + '</p>';
  }
}
