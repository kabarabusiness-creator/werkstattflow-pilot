"""
WerkstattFlow – Seed-Skript für die lokale Dev-Datenbank (SQLite).

Verwendung:
    python3 seed_data.py

Erstellt/überschreibt werkstattflow.db im selben Ordner, legt das Schema
aus schema_sqlite.sql an und füllt es mit denselben Demo-Daten, die auch
im Frontend-Prototyp (mitarbeiteransicht.html) verwendet werden:
5 Aufträge, 17 Aufgaben, digitale Qualitätskontrolle, Reifenlager,
Ersatzteile, Hebebühnen, Team/Rollen mit PIN.

Für den Produktivbetrieb: schema_postgres.sql auf einem echten Postgres-
Server verwenden und dieses Skript auf psycopg2/SQLAlchemy umschreiben.
"""
import sqlite3
import uuid
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from auth import hash_secret  # noqa: E402

DEMO_PASSWORD = "demo-passwort"

DB_PATH = os.environ.get("WERKSTATTFLOW_DB_PATH", os.path.join(os.path.dirname(__file__), "werkstattflow.db"))
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema_sqlite.sql")


def uid():
    return str(uuid.uuid4())


def fake_hash(s):
    return hash_secret(s)


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")
    with open(SCHEMA_PATH) as f:
        conn.executescript(f.read())

    now = datetime.datetime.now().isoformat()

    # --- Werkstatt (Mandant) anlegen ---
    workshop_id = uid()
    conn.execute("INSERT INTO workshops (id,name) VALUES (?,?)", (workshop_id, "Kabara Digital Pilot-Werkstatt"))

    # --- Team / Benutzer / Rollen (siehe Benutzerverwaltung im Frontend) ---
    users = [
        {"name": "Max Mustermann", "email": "max.mustermann@werkstattflow.de", "role": "meister", "pin": "1234"},
        {"name": "Mert Kabara", "email": "mert.kabara@werkstattflow.de", "role": "mechaniker", "pin": "1111"},
        {"name": "Anna Berger", "email": "anna.berger@werkstattflow.de", "role": "serviceberater", "pin": "2580"},
        {"name": "Sinem Demirelli", "email": "sinem.demirelli@werkstattflow.de", "role": "admin", "pin": "0000"},
    ]
    user_by_name = {}
    for u in users:
        u["id"] = uid()
        user_by_name[u["name"]] = u["id"]
        conn.execute(
            "INSERT INTO users (id,workshop_id,name,email,password_hash,pin_hash,role) VALUES (?,?,?,?,?,?,?)",
            (u["id"], workshop_id, u["name"], u["email"], fake_hash("demo-passwort"), fake_hash(u["pin"]), u["role"]),
        )

    # --- Kunden / Fahrzeuge / Aufträge / Aufgaben ---
    orders_data = [
        dict(customer="Max Mustermann", brand="BMW", model="320d", plate="AB · CD 123",
             vin="WBA8E9106K7654321", color="Saphirschwarz metallic",
             engine="2.0L Diesel, 140 kW (190 PS)", fuel="Diesel", transmission="8-Gang Automatik",
             first_reg="2019-05-05", km=125430, tuv="2027-05-01",
             status="arbeit", progress=60, est_min=210,
             tasks=[
                 ("Ölwechsel durchführen", "Wartung", 30, "done", 100, "Motoröl und Ölfilter wechseln."),
                 ("Bremsbeläge vorne wechseln", "Reparatur", 60, "done", 100, "Bremsbeläge vorne demontieren, neue einbauen."),
                 ("Bremsscheiben prüfen", "Prüfung", 30, "progress", 50, "Vordere Bremsscheiben auf Verschleiß prüfen."),
                 ("Luftfilter ersetzen", "Wartung", 20, "open", 0, "Luftfilter tauschen."),
                 ("Fahrzeugdiagnose", "Diagnose", 20, "open", 0, "Fehlerspeicher auslesen."),
             ]),
        dict(customer="Anna Müller", brand="Audi", model="A4 Avant", plate="AB · EF 456",
             vin="WAUZZZ8W9LA123456", color="Gletscherweiß metallic",
             engine="2.0L TDI, 110 kW (150 PS)", fuel="Diesel", transmission="7-Gang S tronic",
             first_reg="2020-03-12", km=88210, tuv="2026-09-01",
             status="arbeit", progress=40, est_min=150,
             tasks=[
                 ("Klimaanlage befüllen", "Wartung", 45, "done", 100, "Kältemittel prüfen, neu befüllen."),
                 ("Zahnriemen prüfen", "Reparatur", 75, "progress", 35, "Zustand Zahnriemen/Spannrolle prüfen."),
                 ("Achsvermessung", "Prüfung", 30, "open", 0, "Achsvermessung nach Fahrwerksarbeiten."),
             ]),
        dict(customer="Thomas Schmidt", brand="Mercedes", model="C220", plate="AB · GH 789",
             vin="WDD2050421F123789", color="Iridiumsilber metallic",
             engine="2.1L Diesel, 125 kW (170 PS)", fuel="Diesel", transmission="9-Gang Automatik",
             first_reg="2018-11-22", km=142900, tuv="2025-11-01",
             status="arbeit", progress=20, est_min=270,
             tasks=[
                 ("Fehlerdiagnose Motor", "Diagnose", 60, "done", 100, "Motorkontrollleuchte ausgelesen."),
                 ("Turbolader prüfen", "Reparatur", 120, "progress", 15, "Ladedruckverlust/Lagerspiel prüfen."),
                 ("Ölwechsel durchführen", "Wartung", 30, "open", 0, "Motoröl und Ölfilter wechseln."),
                 ("Probefahrt", "Prüfung", 60, "open", 0, "Probefahrt zur Kontrolle."),
             ]),
        dict(customer="Lisa Wagner", brand="VW", model="Golf VII", plate="AB · IJ 101",
             vin="WVWZZZAUZKW123654", color="Tornadorot",
             engine="1.5L TSI, 96 kW (130 PS)", fuel="Benzin", transmission="6-Gang manuell",
             first_reg="2021-06-08", km=65430, tuv="2027-03-01",
             status="pruefung", progress=80, est_min=75,
             tasks=[
                 ("Reifen wechseln", "Wartung", 40, "done", 100, "Sommerreifen montiert."),
                 ("Bremsflüssigkeit prüfen", "Wartung", 20, "done", 100, "Füllstand/Zustand geprüft."),
                 ("Endkontrolle", "Prüfung", 15, "progress", 70, "Abschließende Sichtprüfung."),
             ]),
        dict(customer="Paul Weber", brand="Skoda", model="Octavia", plate="AB · KL 202",
             vin="TMBJJ9NE0N0123987", color="Racing Blau metallic",
             engine="2.0L TDI, 110 kW (150 PS)", fuel="Diesel", transmission="7-Gang DSG",
             first_reg="2023-01-19", km=34120, tuv="2026-01-01",
             status="erledigt", progress=100, est_min=80,
             tasks=[
                 ("Inspektion durchführen", "Wartung", 60, "done", 100, "Jahresinspektion durchgeführt."),
                 ("Software-Update", "Diagnose", 20, "done", 100, "Steuergeräte-Software aktualisiert."),
             ]),
    ]

    qc_labels = [
        "Drehmoment geprüft", "Ölstand geprüft", "Probefahrt durchgeführt",
        "Fehlerspeicher gelöscht", "Werkzeug entfernt", "Motorraum sauber",
    ]

    order_num = 10072
    for od in orders_data:
        cust_id = uid()
        conn.execute("INSERT INTO customers (id,workshop_id,name) VALUES (?,?,?)", (cust_id, workshop_id, od["customer"]))

        veh_id = uid()
        conn.execute(
            """INSERT INTO vehicles (id,customer_id,brand,model,plate,vin,color,engine,fuel_type,
               transmission,first_registration,mileage_km,tuv_valid_until)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (veh_id, cust_id, od["brand"], od["model"], od["plate"], od["vin"], od["color"],
             od["engine"], od["fuel"], od["transmission"], od["first_reg"], od["km"], od["tuv"]),
        )

        order_id = uid()
        conn.execute(
            """INSERT INTO orders (id,workshop_id,order_number,vehicle_id,status,progress,
               estimated_duration_min,assigned_mechanic_id) VALUES (?,?,?,?,?,?,?,?)""",
            (order_id, workshop_id, order_num, veh_id, od["status"], od["progress"], od["est_min"],
             user_by_name["Mert Kabara"]),
        )
        order_num += 1

        for i, (title, cat, dur, status, prog, desc) in enumerate(od["tasks"]):
            ist = dur if status == "done" else None
            conn.execute(
                """INSERT INTO tasks (id,order_id,title,category,description,duration_min,
                   ist_min,status,mechanic_id,progress,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (uid(), order_id, title, cat, desc, dur, ist, status, user_by_name["Mert Kabara"], prog, i),
            )

        for j, label in enumerate(qc_labels):
            conn.execute(
                "INSERT INTO qc_checklist_items (id,order_id,label,checked,sort_order) VALUES (?,?,?,?,?)",
                (uid(), order_id, label, 1 if od["status"] == "erledigt" else 0, j),
            )

    # --- Reifenlager ---
    # Kapazität so gewählt, dass sie zur tatsächlichen Reifenmenge unten passt
    # (z.B. Lager A-01: 24+2=26 Reifen bei Kapazität 35 -> ~75% belegt)
    locations = [
        ("Lager A-01", 35), ("Lager A-02", 30), ("Lager B-01", 30),
        ("Lager B-02", 55), ("Lager C-01", 22), ("Lager C-02", 41),
    ]
    loc_ids = {}
    for name, capacity in locations:
        lid = uid()
        loc_ids[name] = lid
        conn.execute("INSERT INTO tire_locations (id,workshop_id,name,capacity) VALUES (?,?,?,?)", (lid, workshop_id, name, capacity))

    tires = [
        ("Michelin Pilot Sport 4", "225/45 R17 94Y", "sommer", 24, "Lager A-01"),
        ("Continental WinterContact TS870", "205/55 R16 91H", "winter", 18, "Lager A-02"),
        ("Bridgestone Turanza T005", "215/60 R17 96H", "sommer", 16, "Lager B-01"),
        ("Michelin CrossClimate 2", "225/50 R17 98W", "ganzjahres", 12, "Lager B-02"),
        ("Continental PremiumContact 6", "205/60 R16 92V", "sommer", 18, "Lager C-01"),
        ("Dunlop Winter Sport 5", "195/65 R15 91T", "winter", 14, "Lager B-02"),
        ("Goodyear Vector 4Seasons", "205/55 R16 91H", "ganzjahres", 9, "Lager C-02"),
        ("Pirelli P Zero", "245/40 R18 93Y", "sommer", 2, "Lager A-01"),
        ("Michelin Pilot Alpin 5", "225/45 R17 91H", "winter", 1, "Lager C-01"),
        ("Continental AllSeasonContact", "205/55 R16 91V", "ganzjahres", 6, "Lager C-02"),
    ]
    for name, size, season, qty, loc in tires:
        conn.execute(
            "INSERT INTO tires (id,workshop_id,name,size,season,qty,location_id) VALUES (?,?,?,?,?,?,?)",
            (uid(), workshop_id, name, size, season, qty, loc_ids[loc]),
        )

    # --- Ersatzteile ---
    parts = [
        ("Bremsbelagsatz vorne", "34116794300", 12, "Regal C-04", 68.00),
        ("Ölfilter", "11427566327", 28, "Regal A-02", 9.50),
        ("Bremsbelagsatz hinten (Audi)", "8K0698151", 4, "Regal C-05", 72.00),
    ]
    for name, oem, stock, loc, price in parts:
        conn.execute(
            "INSERT INTO parts (id,workshop_id,name,oem_number,stock_qty,location,unit_price) VALUES (?,?,?,?,?,?,?)",
            (uid(), workshop_id, name, oem, stock, loc, price),
        )

    # --- Hebebühnen ---
    for n in range(1, 7):
        conn.execute("INSERT INTO lifts (id,workshop_id,number,status) VALUES (?,?,?,?)", (uid(), workshop_id, n, "frei"))

    # --- laufende Schicht für den Mechaniker ---
    conn.execute(
        "INSERT INTO shifts (id,user_id,started_at) VALUES (?,?,?)",
        (uid(), user_by_name["Mert Kabara"], now),
    )

    conn.commit()

    # --- Zweite Werkstatt (nur zum Beweis, dass die Trennung funktioniert) ---
    workshop2_id = uid()
    conn.execute("INSERT INTO workshops (id,name) VALUES (?,?)", (workshop2_id, "Musterwerkstatt Test GmbH"))

    w2_admin_id = uid()
    conn.execute(
        "INSERT INTO users (id,workshop_id,name,email,password_hash,pin_hash,role) VALUES (?,?,?,?,?,?,?)",
        (w2_admin_id, workshop2_id, "Erika Musterfrau", "erika.musterfrau@testwerkstatt.de",
         fake_hash("demo-passwort"), fake_hash("9999"), "admin"),
    )
    w2_cust_id = uid()
    conn.execute("INSERT INTO customers (id,workshop_id,name) VALUES (?,?,?)", (w2_cust_id, workshop2_id, "Test Kunde GmbH"))
    w2_veh_id = uid()
    conn.execute(
        """INSERT INTO vehicles (id,customer_id,brand,model,plate,mileage_km)
           VALUES (?,?,?,?,?,?)""",
        (w2_veh_id, w2_cust_id, "Opel", "Astra", "XY · ZZ 999", 50000),
    )
    w2_order_id = uid()
    conn.execute(
        """INSERT INTO orders (id,workshop_id,order_number,vehicle_id,status,progress,estimated_duration_min,assigned_mechanic_id)
           VALUES (?,?,?,?,?,?,?,?)""",
        (w2_order_id, workshop2_id, 20001, w2_veh_id, "arbeit", 10, 60, w2_admin_id),
    )
    conn.execute(
        """INSERT INTO tasks (id,order_id,title,category,description,duration_min,status,mechanic_id,progress,sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (uid(), w2_order_id, "Testaufgabe Werkstatt 2", "Wartung", "Nur zum Isolationstest.", 30, "open", w2_admin_id, 0, 0),
    )
    for j, label in enumerate(["QK-Punkt A", "QK-Punkt B"]):
        conn.execute(
            "INSERT INTO qc_checklist_items (id,order_id,label,checked,sort_order) VALUES (?,?,?,?,?)",
            (uid(), w2_order_id, label, 0, j),
        )
    conn.execute("INSERT INTO lifts (id,workshop_id,number,status) VALUES (?,?,?,?)", (uid(), workshop2_id, 1, "frei"))

    conn.commit()

    print("Seed abgeschlossen:")
    for tbl in ["users", "customers", "vehicles", "orders", "tasks",
                "qc_checklist_items", "tires", "tire_locations", "parts", "lifts", "shifts"]:
        count = conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        print(f"  {tbl}: {count} Zeilen")

    conn.close()
    print(f"\nDatenbank erstellt: {DB_PATH}")


if __name__ == "__main__":
    main()
