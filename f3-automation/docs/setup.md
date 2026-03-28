# F³ Automation – Setup Dokumentation

## Infrastruktur

### Hetzner VPS
- Ubuntu, 8GB RAM
- IP: `157.90.21.222`
- Firewall: Port 3010 für eigene IP freigegeben
- DNS: `browser.f3-events.de` → 157.90.21.222
- DNS: `n8n.f3-events.de` → 157.90.21.222
- DNS: `nocodb.f3-events.de` → 157.90.21.222

### Coolify (auf dem VPS)
- GitHub App verbunden (Repo: joyclub-puppeteer)
- **Chromium Browser** deployed (Docker, läuft 24/7)
  - Erreichbar: https://browser.f3-events.de
  - Zweck: JOYclub-Session dauerhaft offen halten

### NocoDB
- URL: https://nocodb.f3-events.de
- Projekt-ID: `pu4jkb0uwe4ebev`

#### Tabellen
| Tabelle | ID | Inhalt |
|---|---|---|
| Cookies | `mmvneegxgeltpav` | JOYclub Session-Cookies |
| Events | `mo0qnkmte1sl1mj` | Event-Daten für Auto-Post |

#### Events-Tabelle Felder
- `EventName` – Name des Events
- `EventLink` – Joyclub Event-URL
- `EventDatum` – Datum des Events
- `Event-Beschreibung` – Beschreibung für KI
- `Event-Bild` – Bild-Attachment
- `Wochentag` – z.B. `Mo`, `Mo,Fr` (Komma-getrennt)
- `Anmeldestand` – z.B. "23 von 80 Plätzen belegt"
- `Zusatzinfos` – Zusätzliche Hinweise für den Post
- `Status` – `aktiv` / `inaktiv`

#### Cookies-Tabelle Felder
- `Name` – Cookie-Name
- `Cookie` – Cookie-Wert (voller Header-String)
- `Ablaufdatum` – Datum YYYY-MM-DD

---

## Cookies erneuern (bei 403-Fehler)

1. https://browser.f3-events.de öffnen
2. Auf JOYclub einloggen (falls nicht mehr eingeloggt)
3. F12 → Application → Cookies → `www.joyclub.de`
4. Diese 5 Werte kopieren:
   ```
   FUP_sso_autologin=WERT;
   FUP_vid=WERT;
   FUP_sid=WERT;
   FUPlid=WERT;
   __zlcmid=WERT
   ```
5. NocoDB → Tabelle Cookies → Eintrag `F3-Events` aktualisieren

---

## n8n Workflows

### autopost-v4.json
**Zweck:** Automatisch JOYclub Posts veröffentlichen

**Trigger:**
- Mo–Fr 06:00 Uhr (automatisch)
- Manuell testbar

**Ablauf:**
1. Wochentag ermitteln
2. Cookie aus NocoDB laden & validieren
3. Event aus NocoDB holen (nach Wochentag filtern)
4. GPT-4.1-mini generiert Post-Text
5. Event-Bild herunterladen
6. JOYclub Access Token holen (via Cookie)
7. Bild zu JOYclub hochladen
8. Post veröffentlichen
9. Telegram-Bestätigung senden

**Cookie-Monitoring:**
- Täglich 09:00 Uhr
- Prüft ob Cookies in < 1 Tag ablaufen
- Telegram-Alert an Gruppe `-1003592524930`

---

## Telegram Bots

| Bot | Credential-ID | Zweck |
|---|---|---|
| Chat-Bot | `K91Kw4YS9fiyGIEL` | Cookie-Alerts |
| Joy-Post-Bot | `56WQCkpcuw8EcEDL` | Erfolgs-Meldungen |
| Error-Bot | `SnB3bT6F4HvHGmGW` | Fehler-Meldungen |

Telegram Gruppe: `-1003592524930`

---

## Credentials in n8n

| Name | ID | Typ |
|---|---|---|
| NocoDB Token | `JTFuA8mXBcV97XFf` | nocoDbApiToken |
| OpenAI account | `pq9OempR8pfDox7p` | openAiApi |

---

## Geplante Erweiterungen

- [ ] Stats-Sync Workflow: Fans/Besucher/Reviews von JOYclub → NocoDB → Website
- [ ] RAG-Bot Workflow: Telegram Chatbot mit Wissensdatenbank
- [ ] Auto-Archiv Sync: Neue Events auf JOYclub → automatisch auf f3-events.de
