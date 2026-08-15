-- =====================================================================
-- WerkstattFlow – Lokales Dev-Schema (SQLite)
-- Gleiche Struktur wie schema_postgres.sql, angepasst für lokale
-- Entwicklung/Tests ohne eigenen Datenbankserver (z.B. mit Claude Code).
-- Für den Produktivbetrieb: schema_postgres.sql verwenden.
-- =====================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE workshops (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    pin_hash        TEXT,
    role            TEXT NOT NULL CHECK (role IN ('mechaniker','meister','serviceberater','admin')),
    phone           TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_workshop ON users(workshop_id);

CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE shifts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    total_seconds   INTEGER
);
CREATE INDEX idx_shifts_user ON shifts(user_id);

CREATE TABLE customers (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    phone           TEXT,
    email           TEXT,
    address         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_customers_workshop ON customers(workshop_id);

CREATE TABLE vehicles (
    id                  TEXT PRIMARY KEY,
    customer_id         TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    brand               TEXT NOT NULL,
    model               TEXT NOT NULL,
    plate               TEXT NOT NULL,
    vin                 TEXT UNIQUE,
    color               TEXT,
    engine              TEXT,
    fuel_type           TEXT,
    transmission        TEXT,
    first_registration  TEXT,
    mileage_km          INTEGER,
    tuv_valid_until     TEXT,
    image_url           TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_vehicles_customer ON vehicles(customer_id);
CREATE INDEX idx_vehicles_plate ON vehicles(plate);

CREATE TABLE orders (
    id                      TEXT PRIMARY KEY,
    workshop_id             TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    order_number            INTEGER NOT NULL,
    vehicle_id              TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    status                  TEXT NOT NULL DEFAULT 'arbeit' CHECK (status IN ('arbeit','pruefung','erledigt')),
    progress                INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    estimated_duration_min  INTEGER,
    assigned_mechanic_id    TEXT REFERENCES users(id),
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at            TEXT
);
CREATE UNIQUE INDEX idx_orders_workshop_number ON orders(workshop_id, order_number);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_vehicle ON orders(vehicle_id);
CREATE INDEX idx_orders_workshop ON orders(workshop_id);

CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    category        TEXT,
    description     TEXT,
    duration_min    INTEGER,
    ist_min         INTEGER,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','progress','done')),
    timer_status    TEXT NOT NULL DEFAULT 'idle' CHECK (timer_status IN ('idle','running','paused','done')),
    mechanic_id     TEXT REFERENCES users(id),
    progress        INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT
);
CREATE INDEX idx_tasks_order ON tasks(order_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_time_entries (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    duration_sec    INTEGER
);
CREATE INDEX idx_time_entries_task ON task_time_entries(task_id);

CREATE TABLE task_photos (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    file_url        TEXT NOT NULL,
    taken_by        TEXT REFERENCES users(id),
    taken_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_photos_task ON task_photos(task_id);

CREATE TABLE task_voice_notes (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    transcript          TEXT,
    werkstattbericht    TEXT,
    kundenbeschreibung  TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE qc_checklist_items (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    checked         INTEGER NOT NULL DEFAULT 0,
    checked_by      TEXT REFERENCES users(id),
    checked_at      TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_qc_order ON qc_checklist_items(order_id);

CREATE TABLE parts (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    oem_number      TEXT,
    stock_qty       INTEGER NOT NULL DEFAULT 0,
    location        TEXT,
    unit_price      REAL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_parts_workshop ON parts(workshop_id);

CREATE TABLE order_parts (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    part_id         TEXT NOT NULL REFERENCES parts(id),
    qty             INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'lager' CHECK (status IN ('lager','bestellt')),
    unit_price_at_time REAL
);
CREATE INDEX idx_order_parts_order ON order_parts(order_id);

CREATE TABLE tire_locations (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    capacity        INTEGER NOT NULL DEFAULT 8
);
CREATE UNIQUE INDEX idx_tire_locations_workshop_name ON tire_locations(workshop_id, name);

CREATE TABLE tires (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    size            TEXT NOT NULL,
    season          TEXT NOT NULL CHECK (season IN ('sommer','winter','ganzjahres')),
    qty             INTEGER NOT NULL DEFAULT 0,
    location_id     TEXT REFERENCES tire_locations(id),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tires_location ON tires(location_id);
CREATE INDEX idx_tires_season ON tires(season);
CREATE INDEX idx_tires_workshop ON tires(workshop_id);

CREATE TABLE documents (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    file_url        TEXT NOT NULL,
    uploaded_by     TEXT REFERENCES users(id),
    uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_order ON documents(order_id);

CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
    sender_type     TEXT NOT NULL CHECK (sender_type IN ('kunde','werkstatt')),
    sender_user_id  TEXT REFERENCES users(id),
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    read_at         TEXT
);
CREATE INDEX idx_messages_customer ON messages(customer_id);

CREATE TABLE appointments (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    vehicle_id      TEXT REFERENCES vehicles(id),
    customer_id     TEXT REFERENCES customers(id),
    order_id        TEXT REFERENCES orders(id),
    title           TEXT NOT NULL,
    scheduled_at    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'geplant' CHECK (status IN ('geplant','arbeit','pruefung','erledigt')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_appointments_scheduled ON appointments(scheduled_at);
CREATE INDEX idx_appointments_workshop ON appointments(workshop_id);

CREATE TABLE quick_notes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE support_tickets (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    subject         TEXT NOT NULL,
    message         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','beantwortet','geschlossen')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lifts (
    id              TEXT PRIMARY KEY,
    workshop_id     TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    number          INTEGER NOT NULL,
    order_id        TEXT REFERENCES orders(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'frei' CHECK (status IN ('frei','arbeit','pruefung','erledigt'))
);
CREATE UNIQUE INDEX idx_lifts_workshop_number ON lifts(workshop_id, number);
