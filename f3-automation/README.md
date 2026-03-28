# F³ Automation

Automatisierungs-Workflows und Konfiguration für **F³ – The Next Vibe**.

## Struktur

```
f3-automation/
├── n8n/
│   └── autopost-v4.json       ← JOYclub Auto-Post Workflow
├── docs/
│   └── setup.md               ← Vollständige Setup-Dokumentation
├── nocodb/
│   └── schema.md              ← NocoDB Tabellenstruktur
└── README.md
```

## Workflows

| Datei | Beschreibung | Trigger |
|---|---|---|
| `autopost-v4.json` | Automatischer JOYclub Post | Mo–Fr 06:00 |

## Infrastruktur

- **n8n:** https://n8n.f3-events.de
- **NocoDB:** https://nocodb.f3-events.de
- **Browser:** https://browser.f3-events.de

## Website

Die F³ Homepage liegt in einem separaten Repo:
→ [kuschel190190-ai/kuschel190190-ai-F3-Events](https://github.com/kuschel190190-ai/kuschel190190-ai-F3-Events)

## Cookies erneuern

Bei 403-Fehler → siehe [docs/setup.md](docs/setup.md#cookies-erneuern-bei-403-fehler)
