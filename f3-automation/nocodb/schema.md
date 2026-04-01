# NocoDB Schema – F³ Automation

## Projekt-ID: `pu4jkb0uwe4ebev`
URL: https://nocodb.f3-events.de

---

## Tabelle: Cookies (`mmvneegxgeltpav`)

| Feld | Typ | Beschreibung |
|---|---|---|
| Name | Text | Cookie-Name, z.B. `F3-Events` |
| Cookie | Long Text | Voller Cookie-Header-String |
| Ablaufdatum | Date | YYYY-MM-DD – wann Cookie abläuft |

---

## Tabelle: Events (`mo0qnkmte1sl1mj`)

| Feld | Typ | Beschreibung |
|---|---|---|
| EventName | Text | Name des Events |
| EventLink | URL | Link zur JOYclub Event-Seite |
| EventDatum | Text | Datum als String, z.B. `15.05.2026` |
| Event-Beschreibung | Long Text | Beschreibung für KI-Post-Generierung |
| Event-Bild | Attachment | Bild für den JOYclub Post |
| Wochentag | Text | `Mo`, `Di`, `Mo,Fr` etc. |
| Anmeldestand | Text | z.B. `23 von 80 Plätzen belegt` |
| Zusatzinfos | Long Text | Extra-Infos für den KI-Agenten |
| Status | Single Select | `aktiv` / `inaktiv` |

---

## Tabelle: Ladies-Voting-Kandidaten (`m9qmqh26mhpnlld`)

| Feld | Typ | Beschreibung |
|---|---|---|
| ProfilUrl | URL | JOYclub Profil-URL, z.B. `https://www.joyclub.de/profile/12345678.username.html` |
| Username | Text | JOYclub Benutzername |
| Alter | Number | Alter in Jahren |
| Stadt | Text | Wohnort |
| Fotos | Long Text | JSON-Array mit bis zu 3 CDN-Foto-URLs |
| Status | Single Select | `neu` → `fotos_geladen` → `gesendet` / `fehler` |
| TelegramMsgId | Text | Telegram Message-ID nach erfolgreichem Senden |

**Status-Flow:**
```
[Workflow 1] neu → [Workflow 2] fotos_geladen → [Workflow 3] gesendet
                                              ↘ fehler (bei Fehler)
```
