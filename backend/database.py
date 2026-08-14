"""
Datenbank-Verbindung.

Standard: lokale SQLite-Datei (werkstattflow.db) - ideal für Entwicklung
mit Claude Code, kein Server nötig.

Für Produktion: DATABASE_URL Umgebungsvariable auf eine Postgres-URL
setzen (z.B. "postgresql://user:pass@host:5432/werkstattflow") und
schema_postgres.sql auf dem Server einspielen. Die Query-Funktionen hier
nutzen einfaches SQL und funktionieren mit kleinen Anpassungen
(Platzhalter ? -> %s) auch mit psycopg2.
"""
import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("WERKSTATTFLOW_DB_PATH", os.path.join(os.path.dirname(__file__), "werkstattflow.db"))
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema_sqlite.sql")


def ensure_schema():
    """Legt die Tabellen an, falls die Datenbankdatei noch leer/nicht vorhanden ist."""
    is_new = not os.path.exists(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    if is_new:
        with open(SCHEMA_PATH) as f:
            conn.executescript(f.read())
        conn.commit()
    conn.close()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row):
    return dict(row) if row is not None else None


def rows_to_list(rows):
    return [dict(r) for r in rows]
