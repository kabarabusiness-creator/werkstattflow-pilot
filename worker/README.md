# AutoLeitwerk API (eigener Server)

Ersetzt die Base44-Funktionen `workshopLogin`, `getTabletData`, `tabletAction` und `portalApi`.
Liest und schreibt direkt in die Base44-Datenbank über die Apps-API, damit Tablet und Kundenportal nicht vom
Base44-Integrations-Kontingent abhängen.

## Einrichtung (einmalig)

1. **Cloudflare** → Workers & Pages → *Create* → *Import a repository* → GitHub `werkstattflow-pilot`
   - Root directory: leer lassen (die `wrangler.toml` im Hauptordner zeigt auf `worker/src/index.js`)
   - Deploy command: `npx wrangler deploy` (Standard)
2. **Secrets** setzen: Workers & Pages → `werkstattflow-pilot` → Settings → Variables and Secrets → *Add* (Typ **Secret**)
   - `BASE44_TOKEN` – Base44 Personal Access Token (Workspace → Personal access tokens, **nicht** read-only)
   - `ADMIN_KEY` – langes, frei gewähltes Passwort (mind. 16 Zeichen) für das Daten-Backup
3. Adresse prüfen: `https://werkstattflow-pilot.<konto>.workers.dev/health` → `"configured": true`

Danach deployt Cloudflare jeden Push auf `main` automatisch.

## Endpunkte

| Pfad | Zweck |
|---|---|
| `POST /workshopLogin` | Werkstattcode + Name + PIN → Tablet-Token (12 h) |
| `GET /getTabletData` | Daten der eigenen Werkstatt (Bearer-Token) |
| `POST /tabletAction` | `task_update`, `worktime_start/stop`, `note_add`, `order_complete`, `tire_update`, `media_upload`, `send_portal_link`, `alex_ask`, `tire_scan` |
| `POST /portalApi` | Kundenportal: `get`, `book`, `cancel`, `respond` |
| `POST /fn/<name>` | Ersatz für Base44-Dashboard-Funktionen: `scanTire`, `scanRegistration`, `createTireScanToken`, `tireScanPublic`, `createRegistrationScanToken`, `registrationScanPublic`, `createPhotoUploadToken`, `uploadVehiclePhotoByToken` (Login per Base44-Zugangstoken des Nutzers; Handy-Seiten per Einmal-Token). Das Dashboard leitet diese Aufrufe in `src/lib/serverFunctions.js` hierher um. |
| `GET /demo` | Demo-Dashboard (Einmal-Login als demo@autoleitwerk.de, sieht nur AL-DEMO) |
| `GET /ceo` | CEO-Konsole (nur Inhaber): Login per Einmal-Code an `CEO_EMAIL` (Standard info@autoleitwerk.de); Übersicht, Werkstätten & Funktionen, Support, Entwickler-Tools, Einstellungen |
| `GET /admin/export` | Komplettes Daten-Backup als JSON (Header `X-Admin-Key`) |
| `GET /health` | Server lebt (immer 200) |
| `GET /status` | Tiefer Check für externe Überwachung (200 ok / 503 Problem) |

## KI (ALEX, Reifenscan)

Läuft über **Cloudflare Workers AI** (Binding `AI` in `wrangler.toml`) – kein API-Key, keine Kosten pro Anfrage.
Kostenloses Kontingent: 10.000 Neuronen pro Tag (Reset 00:00 UTC = 2 Uhr deutscher Sommerzeit).
Grob: eine ALEX-Frage ≈ 100–150 Neuronen, ein Reifenscan mit 3 Fotos ≈ 300–500 Neuronen.
Ist das Kontingent leer, antwortet der Server mit `ai_quota` und das Tablet nutzt das lokale Wissen.
Achtung: Auf dem Workers-**Paid**-Plan würde Nutzung über dem Kontingent berechnet.

- Modell: `@cf/mistralai/mistral-small-3.1-24b-instruct` (Text + Bild), Ersatz für Bilder: `@cf/google/gemma-3-12b-it`
- Wissen: Base44-Entität `AlexKnowledge` (Fallback `docs/alex_kb.json`) + Werkstattdaten (Aufträge, Termine, Reifen, Lager)
- Limits: 40 Fragen und 15 Scans pro Mitarbeiter und Stunde
- `alex_execute` (Aufträge/Termine anlegen per ALEX) ist noch nicht umgezogen → `not_available`

## Umschalten / Zurückspringen

- Tablet & Portal: Konstante `API_WORKER` in `index.html` bzw. `kundenapp.html` (leer = Base44-Funktionen).
- Einzelnes Gerät testen: `?api=https://…workers.dev` an die Adresse hängen, `?api=reset` setzt zurück.
- Komplettes Backup des alten Stands: Branch `claude/backup-base44-funktionen-2026-10-08`.

## Test

`node worker/test/run.mjs` – prüft alle Endpunkte gegen eine nachgebaute Base44-API (keine echten Daten).

## Automatisches Backup & Überwachung

- **Backup:** jede Nacht 01:30 UTC (03:30 Uhr Sommerzeit) alle Daten als JSON in den Speicher (KV, Präfix `_backup/`), 14 Tage aufbewahrt. Herunterladen: `/admin` → „Automatische Backups“ → ADMIN_KEY.
- **Überwachung:** alle 15 Minuten Datenbank (Base44), Tablet-App, Kundenportal, Dashboard, Backup-Alter (max. 36 Std.) und E-Mail-Schlüssel. Nach 2 Fehlprüfungen in Folge Mail „Störung erkannt“ an info@autoleitwerk.de, bei Erholung „wieder in Ordnung“ – nur bei Statuswechsel.
- `/health` zeigt `last_backup`, `monitor` und `checked_at`.
- Fällt der Server selbst aus, kann er sich nicht melden → zusätzlich externen Dienst (z. B. UptimeRobot) einrichten:
  - `GET /health` → immer 200, solange der Server antwortet (Server lebt).
  - `GET /status` → **200 = alles ok, 503 = etwas stimmt nicht**: gespeicherte Störung (Datenbank, Tablet, Portal, Dashboard, E-Mail-Schlüssel), Prüfung läuft nicht mehr (letzte Prüfung älter als 45 Min.) oder Backup älter als 36 Std. Die Antwort nennt die Probleme im Klartext (`problems`).
  - Empfohlen: zwei Monitore, je HTTP(s), Intervall 5 Minuten, Alarm per E-Mail an info@autoleitwerk.de.

## CEO-Konsole (`/ceo`)

- Zugang nur für die CEO-Adresse (`CEO_EMAIL`, Standard info@autoleitwerk.de): 6-stelliger Code per Mail (10 Min., 5 Versuche), Sitzung 12 Std. Werkstatt-Logins und Base44-Admins kommen nicht hinein.
- **Werkstätten & Funktionen:** Werkstatt sperren, Abo/Testphase, Module ein/aus. Vom Server durchgesetzt: `tablet`, `alex`, `reifenscan`, `kundenportal` (Feld `Workshop.enabled_modules`, gleiches Format wie die Base44-Seite „Werkstatt-Verwaltung“).
- **Support:** Live-Chats (Base44 `ChatSession`/`ChatMessage`) beantworten + Status; Anfragen aus dem Support-Formular (KV `_tickets/`) per Mail beantworten + Status.
- **Entwickler-Tools:** Status, Prüfung/Backup sofort, Backups laden, Komplett-Export, Test-Mail, Cache leeren, andere CEO-Sitzungen beenden, letzte Server-Fehler.
- **Einstellungen:** Wartungsmodus (sperrt Tablet + Kundenportal für alle) und Ankündigung im Tablet (KV `_ceo/settings`).
- **UptimeRobot:** Secret `UPTIMEROBOT_API_KEY` (Read-Only-Key aus UptimeRobot → Integrations & API) setzen → Übersicht und Entwickler-Tools zeigen Status, Verfügbarkeit 24 h / 7 / 30 Tage, Antwortzeiten und letzte Ausfälle (API v2 getMonitors, 60 s Cache).
- **Verbrauch & Limits:** eigener Zähler (`worker/src/usage.js`): KI-Neuronen (aus Token geschätzt), KI-Aufrufe/Fehler/„Kontingent erschöpft“, Server-Anfragen, E-Mails, Fotos, KV-Schreibvorgänge – pro Tag und Werkstatt. Im Speicher gezählt, alle 5 Min. pro Server-Instanz nach KV `_usage/<Tag>/<Instanz>` (40 Tage).
