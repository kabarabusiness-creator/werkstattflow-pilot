# AutoLeitwerk API (eigener Server)

Ersetzt die Base44-Funktionen `workshopLogin`, `getTabletData`, `tabletAction` und `portalApi`.
Liest und schreibt direkt in die Base44-Datenbank über die Apps-API, damit Tablet und Kundenportal nicht vom
Base44-Integrations-Kontingent abhängen.

## Einrichtung (einmalig)

1. **Cloudflare** → Workers & Pages → *Create* → *Import a repository* → GitHub `werkstattflow-pilot`
   - Root directory: `worker`
   - Deploy command: `npx wrangler deploy` (Standard)
2. **Secrets** setzen: Workers & Pages → `autoleitwerk-api` → Settings → Variables and Secrets → *Add* (Typ **Secret**)
   - `BASE44_TOKEN` – Base44 Personal Access Token (Workspace → Personal access tokens, **nicht** read-only)
   - `ADMIN_KEY` – langes, frei gewähltes Passwort (mind. 16 Zeichen) für das Daten-Backup
3. Adresse prüfen: `https://autoleitwerk-api.<konto>.workers.dev/health` → `"configured": true`

Danach deployt Cloudflare jeden Push auf `main` automatisch.

## Endpunkte

| Pfad | Zweck |
|---|---|
| `POST /workshopLogin` | Werkstattcode + Name + PIN → Tablet-Token (12 h) |
| `GET /getTabletData` | Daten der eigenen Werkstatt (Bearer-Token) |
| `POST /tabletAction` | `task_update`, `worktime_start/stop`, `note_add`, `order_complete`, `tire_update` |
| `POST /portalApi` | Kundenportal: `get`, `book`, `cancel`, `respond` |
| `GET /admin/export` | Komplettes Daten-Backup als JSON (Header `X-Admin-Key`) |
| `GET /health` | Status |

Fotos, KI (ALEX, Reifenscan, Fahrzeugschein) und E-Mails antworten vorerst mit `not_available`.

## Umschalten / Zurückspringen

- Tablet & Portal: Konstante `API_WORKER` in `index.html` bzw. `kundenapp.html` (leer = Base44-Funktionen).
- Einzelnes Gerät testen: `?api=https://…workers.dev` an die Adresse hängen, `?api=reset` setzt zurück.
- Komplettes Backup des alten Stands: Branch `claude/backup-base44-funktionen-2026-10-08`.

## Test

`node worker/test/run.mjs` – prüft alle Endpunkte gegen eine nachgebaute Base44-API (keine echten Daten).
