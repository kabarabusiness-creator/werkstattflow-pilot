// Reifen-Warenwirtschaft auf dem eigenen Server:
//  - Reifengrößen lesen („205/55 R16 91V XL“, „2055516“, „195/70 R15C 104/102R“)
//  - Preislisten der Großhändler (Tyre24/Alzura, Interpneu, Göggel, Gundlach, eigene CSV) im KV-Speicher
//    → schnell durchsuchbar nach Größe, ohne Base44-Abfragelimit
//  - Reifenangebot an Kunden: Seite /angebot mit Auswahl und Wunschtermin

export const TIRE_SUPPLIERS = {
  tyre24: 'Tyre24 / Alzura',
  interpneu: 'Interpneu',
  goeggel: 'Reifen Göggel',
  gundlach: 'Reifen Gundlach',
  sonstige: 'Sonstiger Lieferant',
};

// Reifengröße lesen. Liefert null, wenn keine Größe erkennbar ist.
export function parseDim(input) {
  const s = String(input || '').toUpperCase().replace(/,/g, '.');
  let m = s.match(/(\d{3})\s*\/\s*(\d{2}(?:\.\d)?)\s*(Z?R|-|\s)\s*F?\s*(\d{2}(?:\.5)?)\s*(C)?\b/);
  let width, ratio, rim, cFlag = false, rest = '';
  if (m) { width = +m[1]; ratio = +m[2]; rim = +m[4]; cFlag = !!m[5]; rest = s.slice(m.index + m[0].length); }
  else {
    m = s.match(/(?:^|[^\d])(\d{3})(\d{2})(\d{2})(?:[^\d]|$)/);
    if (!m) return null;
    width = +m[1]; ratio = +m[2]; rim = +m[3]; rest = s.slice(m.index + m[0].length);
  }
  if (width < 125 || width > 395 || ratio < 25 || ratio > 95 || rim < 10 || rim > 24) return null;
  const lisi = rest.match(/^\s*(\d{2,3}(?:\/\d{2,3})?)\s*([A-HJ-NP-Z]|ZR|\(Y\))(?![A-Z])/) || s.match(/\b(\d{2,3}(?:\/\d{2,3})?)\s*([A-HJ-NP-Z])\b(?!\s*\/)/);
  const li = lisi ? lisi[1] : '';
  const si = lisi ? lisi[2].replace(/[()]/g, '') : '';
  const xl = /\bXL\b|EXTRA\s*LOAD|\bREINF/.test(s);
  const rf = /\b(RFT|ROF|SSR|ZP|DSST|EMT|MOE|HRS|RUN\s*-?\s*FLAT|RUNFLAT)\b/.test(s) || /\d{2}\s*R\s*F\s*\d{2}/.test(s);
  return { width, ratio, rim, li, si, c: cFlag, xl: !!xl, rf: !!rf, key: dimKey({ width, ratio, rim }) };
}
export const dimKey = d => (d && d.width && d.ratio && d.rim ? `${d.width}/${d.ratio}R${d.rim}` : '');
export const dimLabel = d => (d ? `${d.width}/${d.ratio} R${d.rim}${d.c ? 'C' : ''}${d.li ? ' ' + d.li + (d.si || '') : ''}${d.xl ? ' XL' : ''}${d.rf ? ' RunFlat' : ''}` : '');

export function guessSeason(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  if (/^(w|wi|win|winter|wr)$/.test(t)) return 'winter';
  if (/^(s|so|som|sommer|summer|su)$/.test(t)) return 'sommer';
  if (/^(g|gj|ga|a|as|all|ganzjahr|ganzjahres|allwetter|allseason|4s)$/.test(t)) return 'ganzjahr';
  if (/ganzjahr|allwetter|all.?season|4.?seasons?|quatrac|crossclimate|vector\s*4|multiseason|quadraxer|cinturato all/.test(t)) return 'ganzjahr';
  if (/winter|snow|schnee|alpin|blizzak|nordic|3pmsf|ice|x-ice|hakkapeliitta|wintrac|sottozero/.test(t)) return 'winter';
  if (/sommer|summer/.test(t)) return 'sommer';
  return '';
}

const num = v => { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : null; const n = Number(String(v).replace(/[€\s]|EUR/gi, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const r2 = n => Math.round(n * 100) / 100;
const grade = v => { const g = String(v || '').trim().toUpperCase().slice(0, 1); return /^[A-G]$/.test(g) ? g : ''; };

// Eine Zeile aus der Preisliste prüfen und kürzen (die Zeilen zerlegt das Dashboard aus der CSV)
export function normRow(r) {
  if (!r || typeof r !== 'object') return null;
  const raw = str(r.name || [r.brand, r.profile, r.dim].filter(Boolean).join(' '), 200);
  const d = parseDim(r.dim || raw);
  if (!d) return null;
  const ek = num(r.ek);
  if (ek == null || ek <= 0 || ek > 20000) return null;
  const ean = str(r.ean, 14).replace(/\D/g, '');
  const li = str(r.li, 8) || d.li; const si = str(r.si, 3).toUpperCase() || d.si;
  const season = ['sommer', 'winter', 'ganzjahr'].includes(r.season) ? r.season : guessSeason(r.season || raw);
  const stock = num(r.stock); const noise = num(r.noise);
  return Object.fromEntries(Object.entries({
    k: d.key, w: d.width, q: d.ratio, d: d.rim, li, si, s: season || undefined,
    e: ean.length >= 8 ? ean : undefined, b: str(r.brand, 40) || undefined, p: str(r.profile, 60) || undefined, a: str(r.art_no, 40) || undefined,
    ek: r2(ek), st: stock != null ? Math.max(0, Math.round(stock)) : undefined, lt: str(r.delivery, 20) || undefined,
    fu: grade(r.fuel) || undefined, we: grade(r.wet) || undefined, no: noise != null && noise > 40 && noise < 90 ? Math.round(noise) : undefined,
    xl: (r.xl === true || d.xl) ? 1 : undefined, rf: (r.rf === true || d.rf) ? 1 : undefined, c: d.c ? 1 : undefined,
    n: raw || undefined,
  }).filter(([, v]) => v !== undefined && v !== ''));
}

export const PL_PREFIX = 'tirepl/';
export async function priceListPut(env, code, supplierKey, supplierName, rows) {
  const clean = []; let skipped = 0;
  for (const r of rows) { const n = normRow(r); if (n) clean.push(n); else skipped++; }
  const meta = { supplier_key: supplierKey, supplier_name: supplierName, updated_at: new Date().toISOString(), count: clean.length };
  await env.PHOTOS.put(`${PL_PREFIX}${code}/${supplierKey}`, JSON.stringify({ ...meta, rows: clean }), { metadata: meta });
  return { ...meta, skipped };
}
export async function priceListMetas(env, code) {
  const res = await env.PHOTOS.list({ prefix: `${PL_PREFIX}${code}/` });
  return (res.keys || []).map(k => k.metadata || { supplier_key: k.name.split('/').pop() }).sort((a, b) => String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''), 'de'));
}
// Suche über alle Preislisten der Werkstatt: gleiche Größe, optional Saison, Mindest-Tragfähigkeit/Geschwindigkeit
const SI_ORDER = 'LMNPQRSTUHVWYZ';
export async function priceSearch(env, code, { dim, season, markup = 0, limit = 60 }) {
  const d = parseDim(dim);
  if (!d) return { dim: null, results: [] };
  const metas = await priceListMetas(env, code);
  const out = [];
  for (const m of metas) {
    const pl = await env.PHOTOS.get(`${PL_PREFIX}${code}/${m.supplier_key}`, { type: 'json' });
    if (!pl || !Array.isArray(pl.rows)) continue;
    for (const r of pl.rows) {
      if (r.k !== d.key) continue;
      if (season && r.s !== season) continue;
      if (d.li && r.li && parseInt(r.li, 10) < parseInt(d.li, 10)) continue;
      if (d.si && r.si && SI_ORDER.indexOf(r.si) >= 0 && SI_ORDER.indexOf(d.si) >= 0 && SI_ORDER.indexOf(r.si) < SI_ORDER.indexOf(d.si)) continue;
      out.push({ supplier_key: m.supplier_key, supplier_name: pl.supplier_name || m.supplier_name, ean: r.e || '', brand: r.b || '', profile: r.p || '', art_no: r.a || '',
        dim: dimLabel({ width: r.w, ratio: r.q, rim: r.d, li: r.li, si: r.si, xl: !!r.xl, rf: !!r.rf, c: !!r.c }), width: r.w, ratio: r.q, rim: r.d, li: r.li || '', si: r.si || '',
        season: r.s || '', ek: r.ek, vk: markup ? r2(r.ek * (1 + markup / 100)) : null, stock: r.st ?? null, delivery: r.lt || '', fuel: r.fu || '', wet: r.we || '', noise: r.no || null, xl: !!r.xl, rf: !!r.rf, name: r.n || '' });
    }
  }
  out.sort((a, b) => (a.stock === 0) - (b.stock === 0) || a.ek - b.ek);
  return { dim: d, total: out.length, results: out.slice(0, limit) };
}

/* ---------- Reifenangebot: öffentliche Seite ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const dDate = iso => { const s = String(iso || '').slice(0, 10).split('-'); return s.length === 3 ? `${s[2]}.${s[1]}.${s[0]}` : ''; };
export const offerExpired = o => !!(o.valid_until && String(o.valid_until).slice(0, 10) < new Date().toISOString().slice(0, 10));
export function offerGross(o, vatFactor) { return (o.options || []).map(x => r2((Number(x.total) || 0) * vatFactor)); }

const PAGE_CSS = 'body{margin:0;background:#f4f4f7;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e}main{max-width:620px;margin:0 auto;padding:24px 16px 48px}.card{background:#fff;border-radius:16px;box-shadow:0 2px 14px #0000000f;padding:20px;margin-top:14px}h1{font-size:22px;margin:6px 0 4px}.muted{color:#5b5b76;font-size:14px}.opt{display:flex;gap:12px;align-items:flex-start;border:2px solid #e4e4ee;border-radius:14px;padding:14px;margin-top:10px;cursor:pointer}.opt:has(input:checked){border-color:#7c3aed;background:#f7f3ff}.opt input{margin-top:5px;width:20px;height:20px;accent-color:#7c3aed}.price{font-size:20px;font-weight:700;white-space:nowrap}.lab{display:inline-block;font-size:12px;font-weight:600;border-radius:6px;padding:1px 6px;margin:4px 4px 0 0;background:#eef}.btn{display:block;width:100%;border:0;border-radius:12px;padding:14px;font:600 16px inherit;cursor:pointer;margin-top:12px}.go{background:#7c3aed;color:#fff}.no{background:#fff;color:#5b5b76;border:1px solid #d6d6e2}label.f{display:block;font-size:13px;font-weight:600;margin:14px 0 4px}input[type=date],textarea{width:100%;box-sizing:border-box;border:1px solid #d6d6e2;border-radius:10px;padding:10px;font:inherit}.ok{background:#ecfdf3;color:#05603a;border-radius:12px;padding:14px}.warn{background:#fff7e6;color:#8a5300;border-radius:12px;padding:14px}';
export function offerPageHtml({ offer, ws, token, vatFactor, done, error }) {
  const head = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Reifenangebot – ${esc(ws.name)}</title><style>${PAGE_CSS}</style></head><body><main>`;
  const foot = `<p class="muted" style="margin-top:22px;text-align:center">${esc(ws.name)}${ws.address ? ' · ' + esc(ws.address) : ''}${ws.phone ? '<br>Telefon ' + esc(ws.phone) : ''}</p></main></body></html>`;
  if (error) return head + `<div class="card"><h1>Angebot nicht verfügbar</h1><p class="muted">${esc(error)}</p></div>` + foot;
  const gross = offerGross(offer, vatFactor);
  const vatNote = vatFactor > 1 ? 'inkl. 19 % MwSt.' : 'Kein Ausweis der Umsatzsteuer (Kleinunternehmer)';
  const optHtml = (x, i, inputs) => {
    const labels = [x.season && ({ sommer: 'Sommer', winter: 'Winter', ganzjahr: 'Ganzjahr' }[x.season]), x.fuel && `Rollwiderstand ${x.fuel}`, x.wet && `Nasshaftung ${x.wet}`, x.noise && `${x.noise} dB`].filter(Boolean);
    return `<label class="opt">${inputs ? `<input type="radio" name="choice" value="${i}" ${i === 0 ? 'checked' : ''}>` : ''}<div style="flex:1"><b>${esc(x.label)}</b><div class="muted">${esc(x.detail || '')}</div><div>${labels.map(l => `<span class="lab">${esc(l)}</span>`).join('')}</div><div class="muted" style="margin-top:4px">${Number(x.qty) || 4} Stück${x.service_total ? ' · inkl. Montage, Wuchten und Entsorgung' : ''}</div></div><div class="price">${eur(gross[i])}</div></label>`;
  };
  const intro = `<p class="muted">Kennzeichen ${esc(offer.license_plate || '–')}${offer.vehicle ? ' · ' + esc(offer.vehicle) : ''}${offer.dimension ? ' · Größe ' + esc(offer.dimension) : ''}</p>${offer.reason ? `<div class="warn" style="margin-top:10px">${esc(offer.reason)}</div>` : ''}${offer.note ? `<p>${esc(offer.note)}</p>` : ''}`;
  if (done || offer.status === 'angenommen' || offer.status === 'abgelehnt') {
    const chosen = offer.status === 'angenommen' && offer.options && offer.options[offer.chosen_option];
    return head + `<div class="card"><p class="muted">${esc(ws.name)}</p><h1>Vielen Dank, ${esc(offer.customer_name || '')}!</h1>${intro}<div class="${chosen ? 'ok' : 'warn'}" style="margin-top:12px">${chosen ? `Sie haben <b>${esc(chosen.label)}</b> für ${eur(gross[offer.chosen_option])} gewählt.${offer.appointment_wish ? ` Ihr Wunschtermin: ${dDate(offer.appointment_wish)}.` : ''} Wir melden uns zur Bestätigung des Termins.` : 'Sie haben das Angebot abgelehnt. Bei Fragen erreichen Sie uns jederzeit.'}</div></div>` + foot;
  }
  if (offerExpired(offer) || offer.status === 'abgelaufen') return head + `<div class="card"><p class="muted">${esc(ws.name)}</p><h1>Angebot abgelaufen</h1>${intro}<p class="muted">Das Angebot war gültig bis ${dDate(offer.valid_until)}. Sprechen Sie uns gern an – wir erstellen Ihnen ein neues.</p></div>` + foot;
  const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return head + `<div class="card"><p class="muted">${esc(ws.name)}</p><h1>Ihr Reifenangebot</h1>${intro}
<form method="POST" action="/angebot"><input type="hidden" name="t" value="${esc(token)}">
${(offer.options || []).map((x, i) => optHtml(x, i, true)).join('')}
<p class="muted" style="font-size:13px;margin-top:8px">Preise ${vatNote}${offer.valid_until ? ` · gültig bis ${dDate(offer.valid_until)}` : ''}.</p>
<label class="f" for="wish">Wunschtermin für den Wechsel (optional)</label><input type="date" id="wish" name="wish" min="${today}">
<label class="f" for="msg">Nachricht an die Werkstatt (optional)</label><textarea id="msg" name="msg" rows="2" maxlength="500"></textarea>
<button class="btn go" type="submit" name="answer" value="yes">Angebot annehmen</button>
<button class="btn no" type="submit" name="answer" value="no">Nein, danke</button></form></div>` + foot;
}

// Artikel aus einer Warenkorb-Zeile (Browser-Erweiterung): Marke und Profil stehen meist vor der Größe
export function tireFromText(text, partNumber) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const d = parseDim(`${t} ${partNumber || ''}`);
  if (!d) return null;
  const pos = t.search(/\d{3}\s*\/\s*\d{2}|\b\d{7}\b/);
  const before = (pos > 0 ? t.slice(0, pos) : '').replace(/[-–,|]+\s*$/, '').trim();
  const words = before.split(' ').filter(Boolean);
  const digits = String(partNumber || '').replace(/\D/g, '');
  const ean = digits.length === 13 || digits.length === 12 ? digits : ((t.match(/\b\d{13}\b/) || [''])[0]);
  return {
    width: d.width, ratio: d.ratio, rim: d.rim, li: d.li, si: d.si, xl: d.xl, rf: d.rf,
    vehicle_type: d.c ? 'transporter' : 'pkw', season: guessSeason(t) || undefined,
    brand: words[0] || '', profile: words.slice(1).join(' '), ean: ean || undefined,
    art_no: digits.length && !ean ? String(partNumber).trim().slice(0, 40) : undefined,
  };
}
