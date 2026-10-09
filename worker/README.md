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
| `GET /admin/export` | Komplettes Daten-Backup als JSON (Header `X-Admin-Key`) |
| `GET /health` | Status |

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
