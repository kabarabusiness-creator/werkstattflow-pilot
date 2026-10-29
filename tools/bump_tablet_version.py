#!/usr/bin/env python3
"""Setzt in index.html die Versionsnummer (?v=...) von tablet.css und tablet.js
auf einen Fingerabdruck des Dateiinhalts.

Immer ausführen, nachdem tablet.css oder tablet.js geändert wurde – sonst kann
ein iPad bis zu 10 Minuten lang eine alte Datei aus dem Zwischenspeicher nehmen,
die nicht zur neuen index.html passt.

    python3 tools/bump_tablet_version.py
"""
import hashlib, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
index = ROOT / "index.html"
html = index.read_text(encoding="utf-8")
for name in ("tablet.css", "tablet.js"):
    h = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()[:10]
    html, n = re.subn(re.escape(name) + r"\?v=[0-9a-zA-Z]+", f"{name}?v={h}", html)
    if n != 1:
        raise SystemExit(f"{name}: erwartet genau 1 Verweis in index.html, gefunden {n}")
    print(f"{name}?v={h}")
index.write_text(html, encoding="utf-8")
