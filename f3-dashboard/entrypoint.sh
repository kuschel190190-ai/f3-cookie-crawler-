#!/bin/sh
set -e

# ── config.js aus Umgebungsvariablen generieren ─────────────────────────────
cat > /usr/share/nginx/html/js/config.js << EOF
const CONFIG = {
  n8n: {
    baseUrl: '/proxy/n8n',
    apiKey: '${N8N_API_KEY}',
    workflows: {
      autopost:    '${N8N_WORKFLOW_AUTOPOST}',
      joyclubSync: '${N8N_WORKFLOW_JOYCLUB_SYNC}',
      statsApi:    '${N8N_WORKFLOW_STATS_API}',
    }
  },
  nocodb: {
    baseUrl: '/proxy/nocodb',
    apiToken: '${NOCODB_API_TOKEN}',
    projectId: '${NOCODB_PROJECT_ID:-pu4jkb0uwe4ebev}',
    tables: {
      cookies: '${NOCODB_TABLE_COOKIES:-mmvneegxgeltpav}',
      events:  '${NOCODB_TABLE_EVENTS:-mo0qnkmte1sl1mj}',
    }
  },
  webhooks: {
    autoLogin: '${N8N_WEBHOOK_AUTO_LOGIN:-https://n8n.f3-events.de/webhook/lv-auto-login}',
    autopush:  '${N8N_WEBHOOK_AUTOPUSH:-https://n8n.f3-events.de/webhook/f3-autopush-manual}',
  },
  refreshInterval: 60000,
  version: '${GIT_COMMIT}',
};
EOF

exec nginx -g 'daemon off;'
