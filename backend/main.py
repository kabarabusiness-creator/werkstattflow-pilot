"""
WerkstattFlow Backend-API.

Start lokal:
    uvicorn main:app --reload --port 8000

Dokumentation (automatisch generiert):
    http://localhost:8000/docs

Mandantentrennung: Jeder Nutzer gehört zu genau einer workshop_id. Diese
steckt im JWT-Token und wird bei JEDER Abfrage als Filter angewendet, damit
Werkstatt A niemals Daten von Werkstatt B sehen oder verändern kann.
"""
import uuid
import datetime
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from fastapi.responses import FileResponse
from database import get_db, ensure_schema, rows_to_list, row_to_dict, DB_PATH
from auth import hash_secret, verify_secret, create_token, get_current_user, require_role

app = FastAPI(title="WerkstattFlow API", version="0.2.0")

# CORS offen für Entwicklung - in Produktion auf die eigene Domain einschränken!
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Einfacher Bruteforce-Schutz für PIN-Versuche (In-Memory - reicht für Pilotbetrieb
# mit einem Server-Prozess. Für mehrere Server-Instanzen: durch Redis o.ä. ersetzen).
PIN_MAX_ATTEMPTS = 5
PIN_LOCKOUT_SECONDS = 60
_pin_attempts = {}  # user_id -> {"count": int, "locked_until": datetime|None}


def check_pin_lockout(user_id: str):
    entry = _pin_attempts.get(user_id)
    if entry and entry.get("locked_until") and datetime.datetime.utcnow() < entry["locked_until"]:
        remaining = int((entry["locked_until"] - datetime.datetime.utcnow()).total_seconds())
        raise HTTPException(status_code=429, detail=f"Zu viele Fehlversuche. Bitte {remaining}s warten.")


def register_pin_failure(user_id: str):
    entry = _pin_attempts.setdefault(user_id, {"count": 0, "locked_until": None})
    entry["count"] += 1
    if entry["count"] >= PIN_MAX_ATTEMPTS:
        entry["locked_until"] = datetime.datetime.utcnow() + datetime.timedelta(seconds=PIN_LOCKOUT_SECONDS)
        entry["count"] = 0


def reset_pin_failures(user_id: str):
    _pin_attempts.pop(user_id, None)


@app.on_event("startup")
def startup():
    ensure_schema()


def new_id() -> str:
    return str(uuid.uuid4())


def now_iso() -> str:
    return datetime.datetime.utcnow().isoformat() + "Z"


# =====================================================================
# Mandantentrennung: Hilfsfunktionen, die prüfen ob ein Datensatz zur
# Werkstatt des angefragenden Nutzers gehört. Bei Nichtübereinstimmung
# wird 404 zurückgegeben (nicht 403!), damit Angreifer nicht mal erfahren,
# ob eine ID bei einer ANDEREN Werkstatt existiert.
# =====================================================================

def require_order_in_workshop(db, order_id: str, workshop_id: str) -> None:
    row = db.execute("SELECT workshop_id FROM orders WHERE id=?", (order_id,)).fetchone()
    if not row or row["workshop_id"] != workshop_id:
        raise HTTPException(status_code=404, detail="Auftrag nicht gefunden")


def require_task_in_workshop(db, task_id: str, workshop_id: str) -> None:
    row = db.execute(
        "SELECT o.workshop_id FROM tasks t JOIN orders o ON o.id=t.order_id WHERE t.id=?", (task_id,)
    ).fetchone()
    if not row or row["workshop_id"] != workshop_id:
        raise HTTPException(status_code=404, detail="Aufgabe nicht gefunden")


def require_qc_in_workshop(db, qc_id: str, workshop_id: str) -> None:
    row = db.execute(
        "SELECT o.workshop_id FROM qc_checklist_items q JOIN orders o ON o.id=q.order_id WHERE q.id=?", (qc_id,)
    ).fetchone()
    if not row or row["workshop_id"] != workshop_id:
        raise HTTPException(status_code=404, detail="QK-Punkt nicht gefunden")


def require_customer_in_workshop(db, customer_id: str, workshop_id: str) -> None:
    row = db.execute("SELECT workshop_id FROM customers WHERE id=?", (customer_id,)).fetchone()
    if not row or row["workshop_id"] != workshop_id:
        raise HTTPException(status_code=404, detail="Kunde nicht gefunden")


# =====================================================================
# Health
# =====================================================================

@app.get("/health")
def health():
    return {"status": "ok", "time": now_iso()}


# =====================================================================
# Auth: Login (Zugangsdaten) + PIN (Profilauswahl, Netflix-Style)
# =====================================================================

class LoginRequest(BaseModel):
    email: str
    password: str


class PinRequest(BaseModel):
    user_id: str
    pin: str


@app.post("/auth/login")
def login(body: LoginRequest):
    """Schritt 1: Zugangsdaten prüfen -> zeigt nur Profile DERSELBEN Werkstatt."""
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email=? AND active=1", (body.email,)).fetchone()
    if not user or not verify_secret(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="E-Mail oder Passwort falsch")
    with get_db() as db:
        profiles = db.execute(
            "SELECT id, name, role FROM users WHERE active=1 AND workshop_id=? ORDER BY name",
            (user["workshop_id"],),
        ).fetchall()
    return {"profiles": rows_to_list(profiles)}


@app.post("/auth/pin")
def verify_pin(body: PinRequest):
    """Schritt 2: PIN prüfen -> Token trägt die workshop_id für alle weiteren Anfragen."""
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (body.user_id,)).fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="Falscher PIN")
    check_pin_lockout(user["id"])
    if not user["pin_hash"] or not verify_secret(body.pin, user["pin_hash"]):
        register_pin_failure(user["id"])
        raise HTTPException(status_code=401, detail="Falscher PIN")
    reset_pin_failures(user["id"])
    token = create_token(user["id"], user["role"], user["workshop_id"])
    with get_db() as db:
        db.execute(
            "INSERT INTO shifts (id, user_id, started_at) VALUES (?, ?, ?)",
            (new_id(), user["id"], now_iso()),
        )
        shift_id = db.execute("SELECT id FROM shifts WHERE user_id=? ORDER BY started_at DESC LIMIT 1", (user["id"],)).fetchone()["id"]
    return {
        "token": token,
        "user": {"id": user["id"], "name": user["name"], "role": user["role"]},
        "shift_id": shift_id,
    }


@app.post("/shifts/{shift_id}/end")
def end_shift(shift_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        row = db.execute(
            "SELECT u.workshop_id FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.id=?", (shift_id,)
        ).fetchone()
        if not row or row["workshop_id"] != user["workshop_id"]:
            raise HTTPException(status_code=404, detail="Schicht nicht gefunden")
        db.execute(
            "UPDATE shifts SET ended_at=?, total_seconds=CAST((julianday(?)-julianday(started_at))*86400 AS INTEGER) WHERE id=?",
            (now_iso(), now_iso(), shift_id),
        )
    return {"ok": True}


# =====================================================================
# Benutzerverwaltung (nur Admin darf Rollen ändern, nur innerhalb der eigenen Werkstatt)
# =====================================================================

@app.get("/users")
def list_users(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            "SELECT id, name, email, role, active FROM users WHERE workshop_id=? ORDER BY name",
            (user["workshop_id"],),
        ).fetchall()
    return rows_to_list(rows)


class RoleUpdate(BaseModel):
    role: str


@app.patch("/users/{user_id}/role")
def update_user_role(user_id: str, body: RoleUpdate, admin: dict = Depends(require_role("admin"))):
    if body.role not in ("mechaniker", "meister", "serviceberater", "admin"):
        raise HTTPException(status_code=400, detail="Ungültige Rolle")
    with get_db() as db:
        target = db.execute("SELECT workshop_id FROM users WHERE id=?", (user_id,)).fetchone()
        if not target or target["workshop_id"] != admin["workshop_id"]:
            raise HTTPException(status_code=404, detail="Benutzer nicht gefunden")
        db.execute("UPDATE users SET role=? WHERE id=?", (body.role, user_id))
    return {"ok": True}


# =====================================================================
# Onboarding: neue Werkstatt (Mandant) selbst registrieren
# =====================================================================

class WorkshopRegister(BaseModel):
    workshop_name: str
    admin_name: str
    admin_email: str
    admin_password: str
    admin_pin: str


@app.post("/onboarding/register")
def register_workshop(body: WorkshopRegister):
    """Legt eine neue Werkstatt mit einem ersten Admin-Konto an. Kein Login nötig -
    das ist bewusst der einzige öffentliche 'Schreib'-Endpunkt der API."""
    if len(body.admin_pin) != 4 or not body.admin_pin.isdigit():
        raise HTTPException(status_code=400, detail="PIN muss aus genau 4 Ziffern bestehen")
    if len(body.admin_password) < 8:
        raise HTTPException(status_code=400, detail="Passwort muss mindestens 8 Zeichen haben")
    with get_db() as db:
        existing = db.execute("SELECT id FROM users WHERE email=?", (body.admin_email,)).fetchone()
        if existing:
            raise HTTPException(status_code=400, detail="Diese E-Mail ist bereits registriert")
        workshop_id = new_id()
        db.execute("INSERT INTO workshops (id, name, created_at) VALUES (?, ?, ?)",
                   (workshop_id, body.workshop_name, now_iso()))
        user_id = new_id()
        db.execute(
            "INSERT INTO users (id, workshop_id, name, email, password_hash, pin_hash, role) VALUES (?, ?, ?, ?, ?, ?, 'admin')",
            (user_id, workshop_id, body.admin_name, body.admin_email,
             hash_secret(body.admin_password), hash_secret(body.admin_pin)),
        )
    token = create_token(user_id, "admin", workshop_id)
    return {
        "token": token,
        "user": {"id": user_id, "name": body.admin_name, "role": "admin"},
        "workshop_id": workshop_id,
    }


# =====================================================================
# Backup: geschützter Download der kompletten Datenbank-Datei.
# Bewusst NICHT über die normale Werkstatt-Anmeldung geschützt (sonst könnte
# ein Werkstatt-Admin die Daten ALLER Werkstätten mit runterladen) - stattdessen
# über einen separaten Secret-Key, den nur der Betreiber (du) kennt.
# =====================================================================

import os as _os

@app.get("/admin/backup")
def download_backup(key: str):
    backup_secret = _os.environ.get("WERKSTATTFLOW_BACKUP_SECRET")
    if not backup_secret:
        raise HTTPException(status_code=503, detail="Backup nicht konfiguriert (WERKSTATTFLOW_BACKUP_SECRET fehlt)")
    if key != backup_secret:
        raise HTTPException(status_code=403, detail="Ungültiger Backup-Schlüssel")
    if not _os.path.exists(DB_PATH):
        raise HTTPException(status_code=404, detail="Datenbank-Datei nicht gefunden")
    filename = f"werkstattflow-backup-{datetime.date.today().isoformat()}.db"
    return FileResponse(DB_PATH, filename=filename, media_type="application/octet-stream")


# =====================================================================
# Kunden, Fahrzeuge, Aufträge ANLEGEN (für Serviceberater/Meister-Desktop)
# =====================================================================

class CustomerCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None


@app.get("/customers")
def list_customers(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM customers WHERE workshop_id=? ORDER BY name", (user["workshop_id"],)
        ).fetchall()
    return rows_to_list(rows)


@app.post("/customers")
def create_customer(body: CustomerCreate, user: dict = Depends(get_current_user)):
    customer_id = new_id()
    with get_db() as db:
        db.execute(
            "INSERT INTO customers (id, workshop_id, name, phone, email, address, created_at) VALUES (?,?,?,?,?,?,?)",
            (customer_id, user["workshop_id"], body.name, body.phone, body.email, body.address, now_iso()),
        )
    return {"id": customer_id}


class VehicleCreate(BaseModel):
    brand: str
    model: str
    plate: Optional[str] = None
    vin: Optional[str] = None
    color: Optional[str] = None
    engine: Optional[str] = None
    fuel_type: Optional[str] = None
    transmission: Optional[str] = None
    mileage_km: Optional[int] = None
    first_registration: Optional[str] = None
    tuv_valid_until: Optional[str] = None


@app.get("/customers/{customer_id}/vehicles")
def list_customer_vehicles(customer_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_customer_in_workshop(db, customer_id, user["workshop_id"])
        rows = db.execute("SELECT * FROM vehicles WHERE customer_id=? ORDER BY brand", (customer_id,)).fetchall()
    return rows_to_list(rows)


@app.post("/customers/{customer_id}/vehicles")
def create_vehicle(customer_id: str, body: VehicleCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_customer_in_workshop(db, customer_id, user["workshop_id"])
        vehicle_id = new_id()
        plate = body.plate.strip() if body.plate and body.plate.strip() else "unbekannt"
        db.execute(
            """INSERT INTO vehicles (id, customer_id, brand, model, plate, vin, color, engine, fuel_type,
               transmission, mileage_km, first_registration, tuv_valid_until)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (vehicle_id, customer_id, body.brand, body.model, plate, body.vin, body.color, body.engine,
             body.fuel_type, body.transmission, body.mileage_km, body.first_registration, body.tuv_valid_until),
        )
    return {"id": vehicle_id}


DEFAULT_QC_LABELS = [
    "Drehmoment geprüft", "Ölstand geprüft", "Probefahrt durchgeführt",
    "Fehlerspeicher gelöscht", "Werkzeug entfernt", "Motorraum sauber",
]


class TaskCreate(BaseModel):
    title: str
    category: Optional[str] = "Wartung"
    description: Optional[str] = None
    duration_min: Optional[int] = 30


class OrderCreate(BaseModel):
    vehicle_id: str
    estimated_duration_min: Optional[int] = None
    assigned_mechanic_id: Optional[str] = None
    tasks: List[TaskCreate] = []


@app.post("/orders")
def create_order(body: OrderCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        vehicle = db.execute(
            "SELECT v.* FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE v.id=? AND c.workshop_id=?",
            (body.vehicle_id, user["workshop_id"]),
        ).fetchone()
        if not vehicle:
            raise HTTPException(status_code=404, detail="Fahrzeug nicht gefunden")
        if body.assigned_mechanic_id:
            mech = db.execute(
                "SELECT id FROM users WHERE id=? AND workshop_id=?", (body.assigned_mechanic_id, user["workshop_id"])
            ).fetchone()
            if not mech:
                raise HTTPException(status_code=404, detail="Mechaniker nicht gefunden")
        next_num = db.execute(
            "SELECT COALESCE(MAX(order_number),10000)+1 AS n FROM orders WHERE workshop_id=?", (user["workshop_id"],)
        ).fetchone()["n"]
        order_id = new_id()
        db.execute(
            """INSERT INTO orders (id, workshop_id, order_number, vehicle_id, status, progress,
               estimated_duration_min, assigned_mechanic_id, created_at, updated_at)
               VALUES (?,?,?,?, 'arbeit', 0, ?, ?, ?, ?)""",
            (order_id, user["workshop_id"], next_num, body.vehicle_id, body.estimated_duration_min,
             body.assigned_mechanic_id, now_iso(), now_iso()),
        )
        for i, t in enumerate(body.tasks):
            db.execute(
                """INSERT INTO tasks (id, order_id, title, category, description, duration_min, status,
                   mechanic_id, progress, sort_order) VALUES (?,?,?,?,?,?, 'open', ?, 0, ?)""",
                (new_id(), order_id, t.title, t.category, t.description, t.duration_min,
                 body.assigned_mechanic_id, i),
            )
        for i, label in enumerate(DEFAULT_QC_LABELS):
            db.execute(
                "INSERT INTO qc_checklist_items (id, order_id, label, checked, sort_order) VALUES (?,?,?,0,?)",
                (new_id(), order_id, label, i),
            )
    return {"id": order_id, "order_number": next_num}


# =====================================================================
# Aufträge
# =====================================================================

ORDER_LIST_QUERY = """
SELECT o.id, o.order_number, o.status, o.progress, o.estimated_duration_min,
       o.created_at, o.completed_at,
       v.id AS vehicle_id, v.brand, v.model, v.plate, v.image_url, v.mileage_km, v.first_registration,
       c.id AS customer_id, c.name AS customer_name,
       (SELECT COUNT(*) FROM tasks t WHERE t.order_id=o.id) AS task_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.order_id=o.id AND t.status='done') AS task_done_count
FROM orders o
JOIN vehicles v ON v.id = o.vehicle_id
JOIN customers c ON c.id = v.customer_id
WHERE o.workshop_id = ?
"""


@app.get("/orders")
def list_orders(status_filter: Optional[str] = None, user: dict = Depends(get_current_user)):
    query = ORDER_LIST_QUERY
    params = [user["workshop_id"]]
    if status_filter:
        query += " AND o.status = ?"
        params.append(status_filter)
    query += " ORDER BY o.order_number"
    with get_db() as db:
        rows = db.execute(query, params).fetchall()
    return rows_to_list(rows)


@app.get("/orders/{order_id}")
def get_order(order_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        order = db.execute(ORDER_LIST_QUERY + " AND o.id = ?", (user["workshop_id"], order_id)).fetchone()
        if not order:
            raise HTTPException(status_code=404, detail="Auftrag nicht gefunden")
        vehicle = db.execute("SELECT * FROM vehicles WHERE id=?", (order["vehicle_id"],)).fetchone()
        tasks = db.execute("SELECT * FROM tasks WHERE order_id=? ORDER BY sort_order", (order_id,)).fetchall()
        tasks_list = rows_to_list(tasks)
        for t in tasks_list:
            photos = db.execute(
                "SELECT file_url FROM task_photos WHERE task_id=? ORDER BY taken_at", (t["id"],)
            ).fetchall()
            t["photos"] = [p["file_url"] for p in photos]
            voice = db.execute(
                "SELECT * FROM task_voice_notes WHERE task_id=? ORDER BY created_at DESC LIMIT 1", (t["id"],)
            ).fetchone()
            t["voice_note"] = row_to_dict(voice)
            if t["timer_status"] == "running":
                open_entry = db.execute(
                    "SELECT started_at FROM task_time_entries WHERE task_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
                    (t["id"],),
                ).fetchone()
                t["timer_started_at"] = open_entry["started_at"] if open_entry else None
            else:
                t["timer_started_at"] = None
        qc = db.execute("SELECT * FROM qc_checklist_items WHERE order_id=? ORDER BY sort_order", (order_id,)).fetchall()
    return {
        "order": row_to_dict(order),
        "vehicle": row_to_dict(vehicle),
        "tasks": tasks_list,
        "qc_items": rows_to_list(qc),
    }


class OrderUpdate(BaseModel):
    status: Optional[str] = None
    progress: Optional[int] = None
    assigned_mechanic_id: Optional[str] = None
    estimated_duration_min: Optional[int] = None


@app.patch("/orders/{order_id}")
def update_order(order_id: str, body: OrderUpdate, user: dict = Depends(get_current_user)):
    fields, params = [], []
    if body.status is not None:
        fields.append("status=?")
        params.append(body.status)
    if body.progress is not None:
        fields.append("progress=?")
        params.append(body.progress)
    if body.assigned_mechanic_id is not None:
        fields.append("assigned_mechanic_id=?")
        params.append(body.assigned_mechanic_id if body.assigned_mechanic_id else None)
    if body.estimated_duration_min is not None:
        fields.append("estimated_duration_min=?")
        params.append(body.estimated_duration_min)
    if not fields:
        return {"ok": True}
    with get_db() as db:
        require_order_in_workshop(db, order_id, user["workshop_id"])
        if body.assigned_mechanic_id:
            mech = db.execute(
                "SELECT id FROM users WHERE id=? AND workshop_id=?", (body.assigned_mechanic_id, user["workshop_id"])
            ).fetchone()
            if not mech:
                raise HTTPException(status_code=404, detail="Mechaniker nicht gefunden")
        fields.append("updated_at=?")
        params.append(now_iso())
        params.append(order_id)
        db.execute(f"UPDATE orders SET {', '.join(fields)} WHERE id=?", params)
    return {"ok": True}


@app.delete("/orders/{order_id}")
def delete_order(order_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_order_in_workshop(db, order_id, user["workshop_id"])
        db.execute("UPDATE lifts SET order_id=NULL, status='frei' WHERE order_id=?", (order_id,))
        db.execute("DELETE FROM orders WHERE id=?", (order_id,))
    return {"ok": True}


@app.post("/orders/{order_id}/complete")
def complete_order(order_id: str, user: dict = Depends(get_current_user)):
    """Schließt einen Auftrag nur ab, wenn die digitale Qualitätskontrolle vollständig ist."""
    with get_db() as db:
        require_order_in_workshop(db, order_id, user["workshop_id"])
        open_qc = db.execute(
            "SELECT COUNT(*) AS n FROM qc_checklist_items WHERE order_id=? AND checked=0", (order_id,)
        ).fetchone()["n"]
        if open_qc > 0:
            raise HTTPException(status_code=400, detail=f"Qualitätskontrolle unvollständig: {open_qc} Punkt(e) offen")
        db.execute("UPDATE tasks SET status='done', progress=100 WHERE order_id=?", (order_id,))
        db.execute(
            "UPDATE orders SET status='erledigt', progress=100, completed_at=? WHERE id=?",
            (now_iso(), order_id),
        )
    return {"ok": True}


# =====================================================================
# Aufgaben & Zeiterfassung
# =====================================================================

class TaskUpdate(BaseModel):
    status: Optional[str] = None
    progress: Optional[int] = None
    timer_status: Optional[str] = None
    ist_min: Optional[int] = None


@app.patch("/tasks/{task_id}")
def update_task(task_id: str, body: TaskUpdate, user: dict = Depends(get_current_user)):
    fields, params = [], []
    for field in ("status", "progress", "timer_status", "ist_min"):
        val = getattr(body, field)
        if val is not None:
            fields.append(f"{field}=?")
            params.append(val)
    if body.status == "done":
        fields.append("completed_at=?")
        params.append(now_iso())
    if not fields:
        return {"ok": True}
    with get_db() as db:
        require_task_in_workshop(db, task_id, user["workshop_id"])
        params.append(task_id)
        db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", params)
    return {"ok": True}


@app.post("/tasks/{task_id}/start")
def start_task_timer(task_id: str, user: dict = Depends(get_current_user)):
    entry_id = new_id()
    with get_db() as db:
        require_task_in_workshop(db, task_id, user["workshop_id"])
        db.execute(
            "INSERT INTO task_time_entries (id, task_id, user_id, started_at) VALUES (?, ?, ?, ?)",
            (entry_id, task_id, user["id"], now_iso()),
        )
        db.execute("UPDATE tasks SET timer_status='running', status='progress' WHERE id=?", (task_id,))
    return {"time_entry_id": entry_id}


@app.post("/tasks/{task_id}/stop")
def stop_task_timer(task_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_task_in_workshop(db, task_id, user["workshop_id"])
        entry = db.execute(
            "SELECT * FROM task_time_entries WHERE task_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        if entry:
            db.execute(
                "UPDATE task_time_entries SET ended_at=?, duration_sec=CAST((julianday(?)-julianday(started_at))*86400 AS INTEGER) WHERE id=?",
                (now_iso(), now_iso(), entry["id"]),
            )
        total = db.execute(
            "SELECT COALESCE(SUM(duration_sec),0) AS s FROM task_time_entries WHERE task_id=?", (task_id,)
        ).fetchone()["s"]
        ist_min = max(1, round(total / 60))
        db.execute("UPDATE tasks SET timer_status='done', status='done', ist_min=?, completed_at=? WHERE id=?",
                    (ist_min, now_iso(), task_id))
    return {"ist_min": ist_min}


class PhotoCreate(BaseModel):
    file_url: str


@app.post("/tasks/{task_id}/photos")
def add_task_photo(task_id: str, body: PhotoCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_task_in_workshop(db, task_id, user["workshop_id"])
        db.execute(
            "INSERT INTO task_photos (id, task_id, file_url, taken_by, taken_at) VALUES (?, ?, ?, ?, ?)",
            (new_id(), task_id, body.file_url, user["id"], now_iso()),
        )
    return {"ok": True}


class VoiceNoteCreate(BaseModel):
    transcript: str
    werkstattbericht: str
    kundenbeschreibung: str


@app.post("/tasks/{task_id}/voice-note")
def add_voice_note(task_id: str, body: VoiceNoteCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_task_in_workshop(db, task_id, user["workshop_id"])
        db.execute(
            """INSERT INTO task_voice_notes (id, task_id, transcript, werkstattbericht, kundenbeschreibung, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (new_id(), task_id, body.transcript, body.werkstattbericht, body.kundenbeschreibung, now_iso()),
        )
    return {"ok": True}


# =====================================================================
# Digitale Qualitätskontrolle
# =====================================================================

class QcUpdate(BaseModel):
    checked: bool


@app.patch("/qc/{item_id}")
def update_qc_item(item_id: str, body: QcUpdate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_qc_in_workshop(db, item_id, user["workshop_id"])
        db.execute(
            "UPDATE qc_checklist_items SET checked=?, checked_by=?, checked_at=? WHERE id=?",
            (1 if body.checked else 0, user["id"], now_iso() if body.checked else None, item_id),
        )
    return {"ok": True}


# =====================================================================
# Reifenlager & Ersatzteile
# =====================================================================

@app.get("/tires")
def list_tires(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            """SELECT t.*, l.name AS location_name FROM tires t
               LEFT JOIN tire_locations l ON l.id = t.location_id
               WHERE t.workshop_id=? ORDER BY t.name""",
            (user["workshop_id"],),
        ).fetchall()
    return rows_to_list(rows)


class TireCreate(BaseModel):
    name: str
    size: str
    season: str
    qty: int = 0
    location_id: Optional[str] = None


@app.post("/tires")
def create_tire(body: TireCreate, user: dict = Depends(get_current_user)):
    if body.season not in ("sommer", "winter", "ganzjahres"):
        raise HTTPException(status_code=400, detail="Ungültige Saison")
    with get_db() as db:
        if body.location_id:
            loc = db.execute(
                "SELECT id FROM tire_locations WHERE id=? AND workshop_id=?", (body.location_id, user["workshop_id"])
            ).fetchone()
            if not loc:
                raise HTTPException(status_code=404, detail="Lagerort nicht gefunden")
        tire_id = new_id()
        db.execute(
            "INSERT INTO tires (id, workshop_id, name, size, season, qty, location_id, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (tire_id, user["workshop_id"], body.name, body.size, body.season, body.qty, body.location_id, now_iso()),
        )
    return {"id": tire_id}


class TireUpdate(BaseModel):
    qty: Optional[int] = None
    location_id: Optional[str] = None
    name: Optional[str] = None
    size: Optional[str] = None
    season: Optional[str] = None


@app.patch("/tires/{tire_id}")
def update_tire(tire_id: str, body: TireUpdate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        row = db.execute("SELECT workshop_id FROM tires WHERE id=?", (tire_id,)).fetchone()
        if not row or row["workshop_id"] != user["workshop_id"]:
            raise HTTPException(status_code=404, detail="Reifen nicht gefunden")
        fields, params = [], []
        for field in ("qty", "location_id", "name", "size", "season"):
            val = getattr(body, field)
            if val is not None:
                fields.append(f"{field}=?")
                params.append(val)
        if fields:
            fields.append("updated_at=?")
            params.append(now_iso())
            params.append(tire_id)
            db.execute(f"UPDATE tires SET {', '.join(fields)} WHERE id=?", params)
    return {"ok": True}


@app.delete("/tires/{tire_id}")
def delete_tire(tire_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        row = db.execute("SELECT workshop_id FROM tires WHERE id=?", (tire_id,)).fetchone()
        if not row or row["workshop_id"] != user["workshop_id"]:
            raise HTTPException(status_code=404, detail="Reifen nicht gefunden")
        db.execute("DELETE FROM tires WHERE id=?", (tire_id,))
    return {"ok": True}


@app.get("/tire-locations")
def list_tire_locations(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            """SELECT l.*, COALESCE(SUM(t.qty),0) AS used_qty, COUNT(t.id) AS tire_types
               FROM tire_locations l LEFT JOIN tires t ON t.location_id=l.id
               WHERE l.workshop_id=? GROUP BY l.id ORDER BY l.name""",
            (user["workshop_id"],),
        ).fetchall()
    return rows_to_list(rows)


class TireLocationCreate(BaseModel):
    name: str
    capacity: int = 60


@app.post("/tire-locations")
def create_tire_location(body: TireLocationCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        loc_id = new_id()
        db.execute(
            "INSERT INTO tire_locations (id, workshop_id, name, capacity) VALUES (?,?,?,?)",
            (loc_id, user["workshop_id"], body.name, body.capacity),
        )
    return {"id": loc_id}


@app.get("/parts")
def list_parts(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM parts WHERE workshop_id=? ORDER BY name", (user["workshop_id"],)
        ).fetchall()
    return rows_to_list(rows)


# =====================================================================
# Dokumente, Nachrichten, Termine
# =====================================================================

@app.get("/orders/{order_id}/documents")
def list_documents(order_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_order_in_workshop(db, order_id, user["workshop_id"])
        rows = db.execute("SELECT * FROM documents WHERE order_id=? ORDER BY uploaded_at DESC", (order_id,)).fetchall()
    return rows_to_list(rows)


@app.get("/customers/{customer_id}/messages")
def list_messages(customer_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_customer_in_workshop(db, customer_id, user["workshop_id"])
        rows = db.execute(
            "SELECT * FROM messages WHERE customer_id=? ORDER BY created_at", (customer_id,)
        ).fetchall()
    return rows_to_list(rows)


class MessageCreate(BaseModel):
    body: str
    order_id: Optional[str] = None


@app.post("/customers/{customer_id}/messages")
def send_message(customer_id: str, body: MessageCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        require_customer_in_workshop(db, customer_id, user["workshop_id"])
        db.execute(
            """INSERT INTO messages (id, customer_id, order_id, sender_type, sender_user_id, body, created_at)
               VALUES (?, ?, ?, 'werkstatt', ?, ?, ?)""",
            (new_id(), customer_id, body.order_id, user["id"], body.body, now_iso()),
        )
    return {"ok": True}


@app.get("/appointments")
def list_appointments(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            """SELECT a.*, c.name AS customer_name, v.brand, v.model
               FROM appointments a
               LEFT JOIN customers c ON c.id = a.customer_id
               LEFT JOIN vehicles v ON v.id = a.vehicle_id
               WHERE a.workshop_id=? ORDER BY a.scheduled_at""",
            (user["workshop_id"],),
        ).fetchall()
    return rows_to_list(rows)


class AppointmentCreate(BaseModel):
    title: str
    scheduled_at: str
    customer_id: Optional[str] = None
    vehicle_id: Optional[str] = None
    order_id: Optional[str] = None


@app.post("/appointments")
def create_appointment(body: AppointmentCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        if body.customer_id:
            require_customer_in_workshop(db, body.customer_id, user["workshop_id"])
        if body.order_id:
            require_order_in_workshop(db, body.order_id, user["workshop_id"])
        appt_id = new_id()
        db.execute(
            """INSERT INTO appointments (id, workshop_id, vehicle_id, customer_id, order_id, title, scheduled_at, status, created_at)
               VALUES (?,?,?,?,?,?,?, 'geplant', ?)""",
            (appt_id, user["workshop_id"], body.vehicle_id, body.customer_id, body.order_id,
             body.title, body.scheduled_at, now_iso()),
        )
    return {"id": appt_id}


class AppointmentUpdate(BaseModel):
    title: Optional[str] = None
    scheduled_at: Optional[str] = None
    customer_id: Optional[str] = None
    status: Optional[str] = None


@app.patch("/appointments/{appointment_id}")
def update_appointment(appointment_id: str, body: AppointmentUpdate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        row = db.execute("SELECT workshop_id FROM appointments WHERE id=?", (appointment_id,)).fetchone()
        if not row or row["workshop_id"] != user["workshop_id"]:
            raise HTTPException(status_code=404, detail="Termin nicht gefunden")
        if body.customer_id:
            require_customer_in_workshop(db, body.customer_id, user["workshop_id"])
        fields, params = [], []
        if body.title is not None:
            fields.append("title=?"); params.append(body.title)
        if body.scheduled_at is not None:
            fields.append("scheduled_at=?"); params.append(body.scheduled_at)
        if body.customer_id is not None:
            fields.append("customer_id=?"); params.append(body.customer_id or None)
        if body.status is not None:
            fields.append("status=?"); params.append(body.status)
        if fields:
            params.append(appointment_id)
            db.execute(f"UPDATE appointments SET {', '.join(fields)} WHERE id=?", params)
    return {"ok": True}


@app.delete("/appointments/{appointment_id}")
def delete_appointment(appointment_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        row = db.execute("SELECT workshop_id FROM appointments WHERE id=?", (appointment_id,)).fetchone()
        if not row or row["workshop_id"] != user["workshop_id"]:
            raise HTTPException(status_code=404, detail="Termin nicht gefunden")
        db.execute("DELETE FROM appointments WHERE id=?", (appointment_id,))
    return {"ok": True}


# =====================================================================
# Schnellnotizen, Support, Hebebühnen
# =====================================================================

@app.get("/notes")
def list_notes(user: dict = Depends(get_current_user)):
    # Über user_id automatisch auf die eigene Werkstatt begrenzt (jeder Nutzer gehört zu genau einer)
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM quick_notes WHERE user_id=? ORDER BY created_at DESC", (user["id"],)
        ).fetchall()
    return rows_to_list(rows)


class NoteCreate(BaseModel):
    text: str


@app.post("/notes")
def create_note(body: NoteCreate, user: dict = Depends(get_current_user)):
    note_id = new_id()
    with get_db() as db:
        db.execute(
            "INSERT INTO quick_notes (id, user_id, text, created_at) VALUES (?, ?, ?, ?)",
            (note_id, user["id"], body.text, now_iso()),
        )
    return {"id": note_id}


@app.delete("/notes/{note_id}")
def delete_note(note_id: str, user: dict = Depends(get_current_user)):
    with get_db() as db:
        db.execute("DELETE FROM quick_notes WHERE id=? AND user_id=?", (note_id, user["id"]))
    return {"ok": True}


class TicketCreate(BaseModel):
    subject: str
    message: str


@app.post("/support/tickets")
def create_ticket(body: TicketCreate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        db.execute(
            "INSERT INTO support_tickets (id, user_id, subject, message, created_at) VALUES (?, ?, ?, ?, ?)",
            (new_id(), user["id"], body.subject, body.message, now_iso()),
        )
    return {"ok": True}


@app.get("/lifts")
def list_lifts(user: dict = Depends(get_current_user)):
    with get_db() as db:
        rows = db.execute(
            """SELECT l.*, o.order_number, o.status AS order_status, v.brand, v.model, c.name AS customer_name
               FROM lifts l
               LEFT JOIN orders o ON o.id = l.order_id
               LEFT JOIN vehicles v ON v.id = o.vehicle_id
               LEFT JOIN customers c ON c.id = v.customer_id
               WHERE l.workshop_id=?
               ORDER BY l.number""",
            (user["workshop_id"],),
        ).fetchall()
    return rows_to_list(rows)


class LiftUpdate(BaseModel):
    order_id: Optional[str] = None  # null = Bühne freigeben


@app.patch("/lifts/{lift_id}")
def update_lift(lift_id: str, body: LiftUpdate, user: dict = Depends(get_current_user)):
    with get_db() as db:
        lift = db.execute("SELECT * FROM lifts WHERE id=? AND workshop_id=?", (lift_id, user["workshop_id"])).fetchone()
        if not lift:
            raise HTTPException(status_code=404, detail="Hebebühne nicht gefunden")
        if body.order_id:
            require_order_in_workshop(db, body.order_id, user["workshop_id"])
            order = db.execute("SELECT status FROM orders WHERE id=?", (body.order_id,)).fetchone()
            db.execute("UPDATE lifts SET order_id=?, status=? WHERE id=?", (body.order_id, order["status"], lift_id))
        else:
            db.execute("UPDATE lifts SET order_id=NULL, status='frei' WHERE id=?", (lift_id,))
    return {"ok": True}
