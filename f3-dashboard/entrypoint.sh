#!/bin/sh
set -e

# ── Basic Auth ──────────────────────────────────────────────────────────────
htpasswd -cb /etc/nginx/.htpasswd "${DASH_USER:-admin}" "${DASH_PASS:-changeme}"

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
  refreshInterval: 60000,
};
EOF

exec nginx -g 'daemon off;'
