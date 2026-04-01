// F3 Dashboard – Deploy History (GitHub API)

const DEPLOY_GITHUB_REPO   = 'kuschel190190-ai/f3-cookie-crawler-';
const DEPLOY_GITHUB_BRANCH = 'f3-dashboard';

async function fetchDeployHistory() {
  const res = await fetch(
    `https://api.github.com/repos/${DEPLOY_GITHUB_REPO}/commits?sha=${DEPLOY_GITHUB_BRANCH}&per_page=15`,
    { headers: { 'Accept': 'application/vnd.github.v3+json' }, signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  return res.json();
}

function renderDeployHistory(container, commits) {
  const currentSha = CONFIG?.version && CONFIG.version !== 'unknown' ? CONFIG.version : null;

  const badge = document.getElementById('section-deploy-badge');
  if (badge) {
    badge.className = 'wf-status-badge status-ok';
    badge.querySelector('.wf-status-icon').textContent = '✓';
    badge.querySelector('.wf-status-text').textContent = commits.length + ' Commits';
  }

  container.innerHTML = commits.map(c => {
    const sha7      = c.sha.substring(0, 7);
    const isCurrent = currentSha && c.sha.startsWith(currentSha.substring(0, 7));
    const msgLines  = c.commit.message.split('\n');
    const title     = msgLines[0];
    const body      = msgLines.slice(1).filter(l => l.trim() && !l.startsWith('Co-Authored')).join(' · ').trim();
    const date      = new Date(c.commit.author.date).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    return '<div class="deploy-commit' + (isCurrent ? ' deploy-commit--current' : '') + '">'
      + '<div class="deploy-commit-meta">'
      +   '<a class="deploy-commit-sha" href="https://github.com/' + DEPLOY_GITHUB_REPO + '/commit/' + c.sha + '" target="_blank" rel="noopener">' + sha7 + '</a>'
      +   (isCurrent ? '<span class="deploy-commit-live">▶ Live</span>' : '')
      +   '<span class="deploy-commit-date">' + date + '</span>'
      + '</div>'
      + '<div class="deploy-commit-msg">' + title + '</div>'
      + (body ? '<div class="deploy-commit-body">' + body + '</div>' : '')
      + '</div>';
  }).join('');
}

async function refreshDeployHistory() {
  const container = document.getElementById('deploy-history-list');
  if (!container) return;

  const badge = document.getElementById('section-deploy-badge');
  try {
    const commits = await fetchDeployHistory();
    renderDeployHistory(container, commits);
  } catch (err) {
    console.warn('[deploy-history]', err);
    if (badge) {
      badge.className = 'wf-status-badge status-unknown';
      badge.querySelector('.wf-status-icon').textContent = '—';
      badge.querySelector('.wf-status-text').textContent = 'GitHub n/a';
    }
    container.innerHTML = '<p style="color:var(--muted);padding:8px 0;font-size:0.85rem">GitHub API nicht erreichbar</p>';
  }
}
