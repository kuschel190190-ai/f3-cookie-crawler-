// F3 Dashboard – API Configuration Template
// → Kopiere diese Datei als "config.js" und trage deine Werte ein
// → config.js wird NICHT in GitHub committet

const CONFIG = {
  n8n: {
    baseUrl: 'https://n8n.f3-events.de',
    apiKey: 'DEIN_N8N_API_KEY',
    workflows: {
      autopost:    'AUTOPOST_WORKFLOW_ID',
      joyclubSync: 'JOYCLUB_SYNC_WORKFLOW_ID',
      statsApi:    'STATS_API_WORKFLOW_ID',
    }
  },
  nocodb: {
    baseUrl: 'https://nocodb.f3-events.de',
    apiToken: 'DEIN_NOCODB_API_TOKEN',
    projectId: 'pu4jkb0uwe4ebev',
    tables: {
      cookies: 'mmvneegxgeltpav',
      events:  'mo0qnkmte1sl1mj',
    }
  },
  refreshInterval: 60_000,
};
