# WerkstattFlow Backend-API

Echtes, lauffähiges Backend für WerkstattFlow – FastAPI (Python) + SQLite
lokal / PostgreSQL für Produktion. Getestet: Login, PIN-Profilauswahl,
Aufträge, Aufgaben, Zeiterfassung, digitale Qualitätskontrolle (inkl.
Abschluss-Sperre), Reifenlager, Rollen-Berechtigungen, Hebebühnen,
Schnellnotizen, Support-Tickets.

**Wichtig:** Dieses Backend ist aktuell NICHT mit der Tablet-App
(`mitarbeiteransicht.html`) verbunden. Die App läuft weiterhin komplett
mit lokalen JavaScript-Daten. Wie du beide verbindest, steht ganz unten
unter "Frontend anbinden".

---

## 1. Lokal starten

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Datenbank mit Demo-Daten anlegen (einmalig, oder erneut für Reset)
python3 seed_data.py

# Server starten
uvicorn main:app --reload --port 8000
```

Interaktive API-Doku (zum Ausprobieren im Browser): **http://localhost:8000/docs**

## 2. Demo-Zugangsdaten

Alle Konten nutzen dasselbe Demo-Passwort. PIN entspricht der Profilauswahl aus der App.

| Name | E-Mail | Passwort | PIN | Rolle |
|---|---|---|---|---|
| Max Mustermann | max.mustermann@werkstattflow.de | demo-passwort | 1234 | meister |
| Mert Kabara | mert.kabara@werkstattflow.de | demo-passwort | 1111 | mechaniker |
| Anna Berger | anna.berger@werkstattflow.de | demo-passwort | 2580 | serviceberater |
| Sinem Demirelli | sinem.demirelli@werkstattflow.de | demo-passwort | 0000 | admin |

Login-Ablauf (zwei Schritte, wie in der App):
```bash
# Schritt 1: Zugangsdaten -> Profilliste
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"mert.kabara@werkstattflow.de","password":"demo-passwort"}'

# Schritt 2: PIN des gewählten Profils -> Token
curl -X POST http://localhost:8000/auth/pin \
  -H "Content-Type: application/json" \
  -d '{"user_id":"<id aus Schritt 1>","pin":"1111"}'

# Danach: Token bei jedem Request mitschicken
curl http://localhost:8000/orders -H "Authorization: Bearer <token>"
```

## 3. Endpunkt-Übersicht

| Bereich | Endpunkte |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/pin`, `POST /shifts/{id}/end` |
| Benutzer | `GET /users`, `PATCH /users/{id}/role` (nur Admin) |
| Aufträge | `GET /orders`, `GET /orders/{id}`, `PATCH /orders/{id}`, `POST /orders/{id}/complete` |
| Aufgaben | `PATCH /tasks/{id}`, `POST /tasks/{id}/start`, `POST /tasks/{id}/stop`, `POST /tasks/{id}/photos`, `POST /tasks/{id}/voice-note` |
| Qualitätskontrolle | `PATCH /qc/{id}` |
| Reifenlager | `GET /tires`, `GET /tire-locations` |
| Ersatzteile | `GET /parts` |
| Dokumente | `GET /orders/{id}/documents` |
| Nachrichten | `GET /customers/{id}/messages`, `POST /customers/{id}/messages` |
| Termine | `GET /appointments` |
| Schnellnotizen | `GET /notes`, `POST /notes`, `DELETE /notes/{id}` |
| Support | `POST /support/tickets` |
| Hebebühnen | `GET /lifts` |

Alle Endpunkte außer `/health`, `/auth/login`, `/auth/pin` verlangen den
`Authorization: Bearer <token>`-Header.

Getestete Geschäftsregel: `POST /orders/{id}/complete` schlägt mit `400`
fehl, solange nicht alle Punkte der digitalen Qualitätskontrolle
abgehakt sind – exakt das Verhalten aus der App.

## 4. Von SQLite auf PostgreSQL (Produktion)

1. `schema_postgres.sql` auf einem Postgres-Server einspielen (z.B.
   [Supabase](https://supabase.com), [Railway](https://railway.app),
   [Neon](https://neon.tech) – alle haben kostenlose Einstiegsstufen).
2. `database.py` austauschen: `sqlite3` → `psycopg2`/`asyncpg`, Platzhalter
   `?` → `%s`. Die restlichen Dateien (`main.py`, `auth.py`) bleiben
   nahezu unverändert, da sie nur mit der `get_db()`-Funktion arbeiten.
3. Umgebungsvariable `DATABASE_URL` setzen statt `WERKSTATTFLOW_DB_PATH`.
4. `WERKSTATTFLOW_SECRET_KEY` auf einen echten, zufälligen Wert setzen
   (z.B. `openssl rand -hex 32`) – niemals den Dev-Default verwenden.
5. CORS in `main.py` von `allow_origins=["*"]` auf die eigene Domain
   einschränken.

## 5. Deployment-Optionen (Backend selbst hosten)

- **Railway / Render / Fly.io**: `git push`, Python-Buildpack erkennt
  `requirements.txt` automatisch, `Procfile`/Start-Command:
  `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Objektspeicher für Fotos (statt Base64 im Frontend): S3-kompatibel,
  z.B. Cloudflare R2 oder AWS S3 – `task_photos.file_url` zeigt dann auf
  die hochgeladene Datei dort.

## 6. Frontend-Integration – bereits erledigt ✅

`mitarbeiteransicht.html` ist jetzt direkt mit diesem Backend verbunden:

- **Login + PIN-Bildschirm** rufen `/auth/login` und `/auth/pin` auf und holen einen echten JWT-Token
- **Nach dem Login** werden die Aufträge live per `/orders` + `/orders/{id}` geladen
- **QC-Checkliste, Zeiterfassung (Start/Stop) und Auftrag-Abschließen** schreiben live über `/qc/{id}`, `/tasks/{id}/start`, `/tasks/{id}/stop` und `/orders/{id}/complete` in die Datenbank
- **Fällt das Backend aus** (z.B. Server nicht gestartet), fällt die App automatisch auf die lokalen Demo-Daten zurück – sie bleibt also immer benutzbar, auch offline

Die Verbindung steht in `mitarbeiteransicht.html` ganz oben im Skript:
```javascript
const API_BASE = 'http://localhost:8000';
```
Das musst du anpassen, sobald das Backend nicht mehr lokal auf deinem Rechner läuft (siehe Abschnitt 5).

### Was noch NICHT live mit dem Backend verbunden ist
Nachrichten, Termine und Dokumente nutzen weiterhin lokale Demo-Daten. Aufträge, Aufgaben, QK, Zeiterfassung, Notizen, Benutzerrollen, Hebebühnen, Reifenlager und Support-Tickets sind live verbunden.

## 7. Sicherheit – bereits eingebaut

- **PIN-Bruteforce-Schutz**: Nach 5 Fehlversuchen wird das Konto 60 Sekunden gesperrt (auch für den richtigen PIN). Aktuell In-Memory, reicht für einen Server-Prozess im Pilotbetrieb.
- **Secret-Key-Warnung**: Startest du den Server ohne `WERKSTATTFLOW_SECRET_KEY`, gibt die Konsole eine deutliche Warnung mit fertigem `export`-Befehl aus. **Für den Piloten unbedingt setzen**, sonst könnten Angreifer selbst gültige Login-Tokens erzeugen:
  ```bash
  export WERKSTATTFLOW_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  uvicorn main:app --port 8000
  ```

## 8. Vor einem echten Piloten (mit Kollegen/echten Daten) noch offen

Diese Punkte kann ich nicht automatisch für dich erledigen, da sie deine eigene Infrastruktur/Entscheidungen betreffen:

- **Hosting**: Backend läuft noch nur lokal auf deinem Rechner. Für mehrere Tablets gleichzeitig brauchst du einen echten Server (Abschnitt 5).
- **Fotos & Sprachnotizen**: Landen aktuell nur in der UI, nicht wirklich in der Datenbank/einem Dateispeicher.
- **Backups**: Bei SQLite reicht regelmäßiges Kopieren der `.db`-Datei; bei Postgres nutzt dein Hosting-Anbieter meist automatische Backups.

## 9. Dateien in diesem Ordner

| Datei | Zweck |
|---|---|
| `main.py` | FastAPI-App mit allen Endpunkten |
| `database.py` | DB-Verbindung (SQLite lokal, austauschbar) |
| `auth.py` | Passwort/PIN-Hashing (bcrypt) + JWT |
| `schema_sqlite.sql` | Tabellen-Struktur (lokal) |
| `seed_data.py` | Füllt die DB mit denselben Demo-Daten wie im Frontend |
| `requirements.txt` | Python-Abhängigkeiten |
| `werkstattflow.db` | Fertig befüllte SQLite-Datenbank zum sofortigen Start |
