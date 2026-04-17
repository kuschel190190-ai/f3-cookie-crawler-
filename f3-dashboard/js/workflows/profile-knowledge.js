// Profil-Homepages: gescrapte F3-Infoseiten (LV-Regeln, Hygiene, FFF-Unterschied)
// Quelle: n8n Homepage-Sektion → Status-Store profile-knowledge

async function fetchProfileKnowledge() {
  const res = await fetch('/proxy/profile-knowledge', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return json.data || null;
}

function renderProfileKnowledge(data) {
  const badge  = document.getElementById('badge-profile-knowledge');
  const content = document.getElementById('profile-knowledge-content');
  if (!badge || !content) return;

  if (!data || !data.pages || data.pages.length === 0) {
    badge.className = 'wf-status-badge status-warn';
    badge.querySelector('.wf-status-icon').textContent = '⚠';
    badge.querySelector('.wf-status-text').textContent = 'Nicht geladen';
    content.innerHTML = '<p style="color:var(--muted);font-size:0.82rem">Noch keine Daten – Homepage-Scraping ausführen.</p>';
    return;
  }

  const ok = data.pages.filter(p => p.text && p.text.length > 50).length;
  badge.className = ok > 0 ? 'wf-status-badge status-ok' : 'wf-status-badge status-warn';
  badge.querySelector('.wf-status-icon').textContent = ok > 0 ? '✓' : '⚠';
  badge.querySelector('.wf-status-text').textContent = ok + ' Seiten';

  const ago = data.scrapedAt ? relativeTime(data.scrapedAt) : '—';

  content.innerHTML =
    '<div style="font-size:0.75rem;color:var(--muted);margin-bottom:0.5rem">Abgerufen: ' + ago + '</div>'
    + data.pages.map(p => {
        const title = p.title || p.slug || p.url;
        const excerpt = p.text ? p.text.substring(0, 200).replace(/</g,'&lt;') + (p.text.length > 200 ? '…' : '') : '';
        const hasText = p.text && p.text.length > 50;
        return '<details style="margin-bottom:0.4rem;border:1px solid rgba(255,255,255,0.08);border-radius:4px">'
          + '<summary style="cursor:pointer;padding:0.35rem 0.5rem;font-size:0.82rem;font-weight:600;list-style:none;display:flex;align-items:center;gap:0.4rem">'
          + (hasText ? '📄' : '⚠') + ' ' + title
          + '</summary>'
          + (hasText
              ? '<div style="padding:0.35rem 0.5rem 0.5rem;font-size:0.78rem;color:var(--muted,#aaa);line-height:1.5;border-top:1px solid rgba(255,255,255,0.06)">'
                + excerpt
                + (p.text.length > 200
                    ? '<details style="margin-top:0.3rem"><summary style="cursor:pointer;color:var(--accent,#c074e8);font-size:0.75rem;list-style:none">Volltext</summary>'
                      + '<div style="margin-top:0.3rem;white-space:pre-wrap">' + p.text.replace(/</g,'&lt;') + '</div></details>'
                    : '')
                + '</div>'
              : '<div style="padding:0.3rem 0.5rem;font-size:0.75rem;color:var(--muted)">Kein Inhalt (Login erforderlich?)</div>')
          + '</details>';
      }).join('');
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
