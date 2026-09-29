#!/usr/bin/env python3
"""
Generiert die ALEX-Wissensdatenbank-Übersicht (Markdown + HTML) direkt aus dem
AI_KB-Array in index.html.

Immer ausführen, nachdem AI_KB in index.html geändert wurde (neue Einträge,
Umbenennung, gelöschte Einträge), damit die Übersichtsdateien aktuell bleiben:

    python3 tools/generate_kb_doc.py

Erzeugt:
    docs/ALEX_Wissensdatenbank.md
    docs/ALEX_Wissensdatenbank.html

Beide Dateien werden aus dem Skript neu aufgebaut (kein manuelles Editieren
der Output-Dateien nötig/sinnvoll) und sollten zusammen mit index.html
committet werden.
"""
import re
import json
import base64
import html as htmlmod
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "index.html"
LOGO_PATH = Path(__file__).resolve().parent / "assets" / "autoleitwerk-logo.png"
OUT_DIR = REPO_ROOT / "docs"
OUT_MD = OUT_DIR / "ALEX_Wissensdatenbank.md"
OUT_HTML = OUT_DIR / "ALEX_Wissensdatenbank.html"

esc = htmlmod.escape

# ---------------------------------------------------------------------------
# 1. AI_KB aus index.html extrahieren
# ---------------------------------------------------------------------------

def load_entries():
    src = INDEX_HTML.read_text(encoding="utf-8")
    start = src.index("const AI_KB = [")
    end = src.index("\n];", start) + 3
    block = src[start:end]

    entries = []
    for m in re.finditer(r"\{\s*match\s*:\s*(/.*?/[a-z]*)\s*,\s*reply\s*:\s*`(.*?)`\s*\}", block, re.S):
        regex_src = m.group(1)
        reply = m.group(2)
        title_m = re.search(r"<b>(.*?)</b>", reply, re.S)
        title = title_m.group(1) if title_m else "(kein Titel)"
        title = re.sub(r"&amp;", "&", title)
        items = re.findall(r"<li>(.*?)</li>", reply, re.S)
        items = [re.sub(r"<.*?>", "", re.sub(r"&amp;", "&", i)).strip() for i in items]
        entries.append({"title": title, "regex": regex_src, "items": items})
    return entries


# ---------------------------------------------------------------------------
# 2. Lesbare Stichworte ("Befehle") aus dem Trigger-Regex ableiten
# ---------------------------------------------------------------------------

def top_level_split(s):
    parts, depth, cur, i = [], 0, "", 0
    while i < len(s):
        c = s[i]
        if c == "\\":
            cur += s[i:i + 2]
            i += 2
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        if c == "|" and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    parts.append(cur)
    return parts


def clean_part(p):
    p = re.sub(r"\(\?![^)]*\)", "", p)

    def repl_group(m):
        return m.group(1).replace("|", "/")

    for _ in range(3):
        p = re.sub(r"\(\?:([^()]*)\)", repl_group, p)
        p = re.sub(r"\(([^()]*)\)", repl_group, p)
    p = p.replace("\\b", "").replace("\\s", " ").replace("\\/", "/").replace("\\.", ".")
    p = p.replace(".*", " … ")
    p = p.replace("?", "")
    p = re.sub(r"\s+", " ", p).strip(" …")
    return p.strip()


def extract_keywords(regex_src):
    inner = regex_src.strip()
    inner = re.sub(r"^/", "", inner)
    inner = re.sub(r"/[a-z]*$", "", inner)
    parts = top_level_split(inner)
    cleaned = [clean_part(p) for p in parts]
    cleaned = [c for c in cleaned if c]
    seen, out = set(), []
    for c in cleaned:
        if c.lower() not in seen:
            seen.add(c.lower())
            out.append(c)
    return out[:5]


# ---------------------------------------------------------------------------
# 3. Grobe Themen-Zuordnung
#    Reihenfolge/Umfang der Bereiche folgt der Struktur, in der die Einträge
#    im AI_KB-Array stehen (Kommentar-Header dort sind die Quelle der
#    Wahrheit). Neue Bereiche/Kommentar-Header in index.html sollten hier
#    ergänzt werden, statt Einträge einfach in "Sonstiges" landen zu lassen.
# ---------------------------------------------------------------------------

def build_groups(n_total):
    fehlercodes_idx = [31, 35, 36, 37, 38]
    wartung_idx = [32, 33, 34] + list(range(39, 54))
    groups = [
        ("diag-workflow", "Diagnose-Workflow & Fehlercode-Grundlagen", list(range(0, 7))),
        ("elektrik", "Schaltpläne & Elektrik – Grundlagen", list(range(7, 14))),
        ("symptome", "Symptom-/Phänomen-Diagnose ohne DTC", list(range(14, 21))),
        ("komponenten", "Komponentenwissen & Sensorik", list(range(21, 27))),
        ("anlernen", "Anlernprozeduren & Codierungen", list(range(27, 31))),
        ("dtc", "Fehlercodes – spezifische DTCs", fehlercodes_idx),
        ("wartung", "Allgemeine Wartung & Service", wartung_idx),
        ("bmw-allg", "BMW – markenübergreifend", list(range(54, 60))),
        ("bmw-e30", "BMW E30 – Schaltplan/Verkabelung", list(range(60, 68))),
        ("bmw-e92", "BMW E92", list(range(68, 73))),
    ]
    covered = set()
    for _, _, idxs in groups:
        covered.update(idxs)
    rest = [i for i in range(n_total) if i not in covered]
    if rest:
        groups.append(("sonstiges", "Sonstiges / noch nicht einsortiert", rest))
    return groups


# ---------------------------------------------------------------------------
# 4. Markdown-Export
# ---------------------------------------------------------------------------

def write_markdown(entries, groups):
    out = []
    out.append("# ALEX – Wissensdatenbank (Stand: " + datetime.now().strftime("%d.%m.%Y") + ")")
    out.append("")
    out.append("Automatisch generiert aus `AI_KB` in `index.html` – bitte nicht von Hand editieren, "
                "sondern `tools/generate_kb_doc.py` erneut ausführen.")
    out.append("")
    out.append(f"**Gesamtzahl Einträge:** {len(entries)}")
    out.append("")
    out.append("---")
    out.append("")

    n = 1
    for _, name, idxs in groups:
        out.append(f"## {name}")
        out.append("")
        for idx in idxs:
            e = entries[idx]
            out.append(f"**{n}. {e['title']}**")
            out.append(f"*Trigger (Beispielmuster):* `{e['regex']}`")
            out.append("")
            for it in e["items"]:
                out.append(f"- {it}")
            out.append("")
            n += 1
        out.append("---")
        out.append("")

    OUT_DIR.mkdir(exist_ok=True)
    OUT_MD.write_text("\n".join(out), encoding="utf-8")


# ---------------------------------------------------------------------------
# 5. HTML-Export (AutoLeitwerk-Branding, Suchfunktion)
# ---------------------------------------------------------------------------

def write_html(entries, groups):
    logo_b64 = base64.b64encode(LOGO_PATH.read_bytes()).decode()

    def entry_card(e, num):
        kw_html = "".join(f'<span class="chip">{esc(k)}</span>' for k in e["keywords"])
        items_html = "".join(f"<li>{esc(it)}</li>" for it in e["items"])
        search_blob = esc((e["title"] + " " + " ".join(e["keywords"]) + " " + " ".join(e["items"])).lower())
        return f'''<article class="card" data-search="{search_blob}">
      <div class="card-num">{num:02d}</div>
      <h3>{esc(e['title'])}</h3>
      <div class="chips">{kw_html}</div>
      <ul>{items_html}</ul>
    </article>'''

    sections_html, nav_html = [], []
    n = 1
    for anchor, name, idxs in groups:
        nav_html.append(f'<a href="#{anchor}" class="navlink">{esc(name)}</a>')
        cards = []
        for idx in idxs:
            cards.append(entry_card(entries[idx], n))
            n += 1
        sections_html.append(f'''
    <section id="{anchor}" class="kb-section">
      <div class="section-head">
        <h2>{esc(name)}</h2>
        <span class="count">{len(idxs)} Einträge</span>
      </div>
      <div class="card-grid">{''.join(cards)}</div>
    </section>''')

    total = len(entries)
    date_str = datetime.now().strftime("%d.%m.%Y")

    html_out = f'''<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ALEX – Wissensdatenbank | AutoLeitwerk</title>
<style>
  :root{{
    --bg: #0d0a1a; --bg-soft: #161129; --card: #1b1533; --card-border: #2c2350;
    --text: #f2f0fa; --text-dim: #a8a0c4; --accent1: #8b5cf6; --accent2: #d946ef;
    --accent-grad: linear-gradient(135deg, var(--accent1), var(--accent2));
  }}
  *{{box-sizing:border-box;}}
  body{{
    margin:0; background:
      radial-gradient(1200px 600px at 10% -10%, rgba(139,92,246,.18), transparent 60%),
      radial-gradient(1000px 500px at 100% 0%, rgba(217,70,239,.14), transparent 55%),
      var(--bg);
    color:var(--text); font-family:'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;
  }}
  header{{
    position:sticky; top:0; z-index:20; backdrop-filter: blur(14px);
    background: rgba(13,10,26,.82); border-bottom:1px solid var(--card-border);
    padding:18px 28px; display:flex; align-items:center; justify-content:space-between; gap:20px; flex-wrap:wrap;
  }}
  .brand{{display:flex; align-items:center; gap:14px;}}
  .brand img{{height:34px; width:auto;}}
  .brand-text{{font-weight:700; font-size:15px; color:var(--text-dim); letter-spacing:.5px;}}
  .stats{{display:flex; gap:10px; flex-wrap:wrap;}}
  .stat{{background:var(--card); border:1px solid var(--card-border); border-radius:10px; padding:7px 14px; font-size:13px; color:var(--text-dim);}}
  .stat b{{color:var(--text); font-size:15px;}}
  .hero{{padding:38px 28px 10px; max-width:1200px; margin:0 auto;}}
  .hero h1{{font-size:clamp(28px,4vw,42px); margin:0 0 8px; font-weight:800; background:var(--accent-grad); -webkit-background-clip:text; background-clip:text; color:transparent;}}
  .hero p{{color:var(--text-dim); font-size:15px; max-width:720px; line-height:1.6; margin:0 0 22px;}}
  .search-wrap{{max-width:1200px; margin:0 auto; padding:0 28px 8px;}}
  #search{{width:100%; padding:14px 18px; border-radius:14px; border:1px solid var(--card-border); background:var(--card); color:var(--text); font-size:15px; outline:none; font-family:inherit;}}
  #search:focus{{border-color:var(--accent1); box-shadow:0 0 0 3px rgba(139,92,246,.25);}}
  #search::placeholder{{color:var(--text-dim);}}
  nav.toc{{max-width:1200px; margin:0 auto; padding:16px 28px 0; display:flex; gap:8px; flex-wrap:wrap;}}
  .navlink{{color:var(--text-dim); text-decoration:none; font-size:12.5px; font-weight:600; background:var(--bg-soft); border:1px solid var(--card-border); border-radius:999px; padding:7px 14px; transition:.15s;}}
  .navlink:hover{{color:var(--text); border-color:var(--accent1);}}
  main{{max-width:1200px; margin:0 auto; padding:20px 28px 80px;}}
  .kb-section{{margin-top:44px; scroll-margin-top:90px;}}
  .section-head{{display:flex; align-items:baseline; gap:12px; margin-bottom:16px; border-bottom:1px solid var(--card-border); padding-bottom:10px;}}
  .section-head h2{{font-size:20px; margin:0; font-weight:700;}}
  .section-head .count{{font-size:12.5px; color:var(--text-dim); background:var(--bg-soft); padding:3px 10px; border-radius:999px;}}
  .card-grid{{display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:14px;}}
  .card{{background:var(--card); border:1px solid var(--card-border); border-radius:14px; padding:16px 16px 14px; position:relative; transition:.15s; overflow:hidden;}}
  .card:hover{{border-color:var(--accent1); transform:translateY(-2px);}}
  .card-num{{position:absolute; top:12px; right:14px; font-size:11px; font-weight:700; color:var(--accent2); opacity:.55; font-variant-numeric:tabular-nums;}}
  .card h3{{font-size:14.5px; margin:0 26px 10px 0; line-height:1.35; font-weight:700; color:var(--text);}}
  .chips{{display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px;}}
  .chip{{font-size:10.5px; padding:3px 9px; border-radius:999px; background:rgba(139,92,246,.14); border:1px solid rgba(139,92,246,.35); color:#c9b8ff; white-space:nowrap;}}
  .card ul{{margin:0; padding-left:18px; color:var(--text-dim); font-size:12.5px; line-height:1.55;}}
  .card ul li{{margin-bottom:5px;}}
  .card ul li::marker{{color:var(--accent2);}}
  .hidden{{display:none !important;}}
  .empty-state{{text-align:center; color:var(--text-dim); padding:60px 20px; display:none;}}
  footer{{text-align:center; padding:30px 20px 50px; color:var(--text-dim); font-size:12.5px; border-top:1px solid var(--card-border); margin-top:20px;}}
  footer b{{color:var(--text);}}
  @media (max-width:640px){{
    header{{padding:14px 16px;}} .hero{{padding:26px 16px 6px;}} .search-wrap{{padding:0 16px 8px;}}
    nav.toc{{padding:14px 16px 0;}} main{{padding:16px 16px 60px;}}
  }}
</style>
</head>
<body>

<header>
  <div class="brand">
    <img src="data:image/png;base64,{logo_b64}" alt="AutoLeitwerk">
    <span class="brand-text">ALEX WISSENSDATENBANK</span>
  </div>
  <div class="stats">
    <div class="stat"><b>{total}</b> Einträge</div>
    <div class="stat"><b>{len(groups)}</b> Bereiche</div>
    <div class="stat">Stand <b>{date_str}</b></div>
  </div>
</header>

<div class="hero">
  <h1>Wissen &amp; Befehle</h1>
  <p>Vollständige Übersicht aller Themen, auf die ALEX aktuell reagiert – inkl. der Stichworte/Formulierungen, die den jeweiligen Eintrag auslösen ("Befehle"), und der kompletten Antwort. Diese Seite wird automatisch aus der Wissensdatenbank generiert (siehe <code>tools/generate_kb_doc.py</code>).</p>
</div>

<div class="search-wrap">
  <input id="search" type="text" placeholder="Wissensdatenbank durchsuchen … (z.B. „Vibration“, „E30“, „CAN-Bus“)">
</div>

<nav class="toc">
  {''.join(nav_html)}
</nav>

<main id="main">
  {''.join(sections_html)}
  <div class="empty-state" id="emptyState">Keine Treffer für diese Suche.</div>
</main>

<footer>
  <b>AutoLeitwerk</b> – ALEX (AutoLeitwerk Expert eXchange) · automatisch generiert aus der Wissensdatenbank
</footer>

<script>
  const search = document.getElementById('search');
  const sections = Array.from(document.querySelectorAll('.kb-section'));
  const emptyState = document.getElementById('emptyState');
  search.addEventListener('input', () => {{
    const q = search.value.trim().toLowerCase();
    let anyVisible = false;
    sections.forEach(sec => {{
      let sectionHasVisible = false;
      sec.querySelectorAll('.card').forEach(card => {{
        const match = !q || card.dataset.search.includes(q);
        card.classList.toggle('hidden', !match);
        if (match) {{ sectionHasVisible = true; anyVisible = true; }}
      }});
      sec.classList.toggle('hidden', !sectionHasVisible);
    }});
    emptyState.style.display = anyVisible ? 'none' : 'block';
  }});
</script>

</body>
</html>'''

    OUT_DIR.mkdir(exist_ok=True)
    OUT_HTML.write_text(html_out, encoding="utf-8")


def main():
    entries = load_entries()
    for e in entries:
        e["keywords"] = extract_keywords(e["regex"])
    groups = build_groups(len(entries))
    write_markdown(entries, groups)
    write_html(entries, groups)
    print(f"OK: {len(entries)} Einträge -> {OUT_MD.relative_to(REPO_ROOT)}, {OUT_HTML.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
