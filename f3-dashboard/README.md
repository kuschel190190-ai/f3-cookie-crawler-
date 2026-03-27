# F³ Dashboard

Internes Automation-Dashboard für F3-Events.
Zeigt den Live-Status aller 4 Workflows auf einen Blick.

## Workflows

| Karte | Quelle | Intervall |
|-------|--------|-----------|
| Cookie Crawler | NocoDB Cookies-Tabelle | 60s Polling |
| Website + Sync | n8n joyclub-sync | 60s Polling |
| Auto-Posting | n8n autopost-v4 | 60s Polling |
| Ladies Voting | TBD | TBD |

## Setup

### 1. API-Keys eintragen

Öffne `js/config.js` und trage ein:
- `n8n.apiKey` → n8n → Settings → API Keys
- `n8n.workflows.*` → Workflow-IDs aus der n8n-URL
- `nocodb.apiToken` → NocoDB → Team & Auth → API Tokens

### 2. n8n Workflow-IDs finden

In n8n auf den Workflow klicken → URL zeigt: `.../workflow/XXXX` → diese ID eintragen.

### 3. Docker Build & Run (lokal testen)

```bash
docker build --build-arg DASH_USER=admin --build-arg DASH_PASS=deinPasswort -t f3-dashboard .
docker run -p 8080:80 f3-dashboard
# Öffne: http://localhost:8080
```

### 4. Coolify Deployment

1. Neues Projekt in Coolify anlegen
2. GitHub Repo `f3-dashboard` verbinden
3. Build-Args setzen: `DASH_USER` + `DASH_PASS`
4. Domain: `dashboard.f3-events.de`
5. Deploy

## Sicherheit

- Basic Auth via nginx (Passwort als Docker Build-Arg)
- API-Keys nur im config.js (nicht im Git committed)
- `noindex, nofollow` Meta-Tag verhindert Suchmaschinen-Indexierung
