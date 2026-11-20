// Warenkorb-Zeilen zerlegen – gleiche Regeln wie „Warenkorb einfügen“ im Dashboard (src/lib/partsCatalogs.js).
export function parseMoney(v) {
  if (v == null) return null;
  let s = String(v).replace(/[€\s]|EUR/gi, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const PRICE_RE = /^-?\d{1,3}(?:\.\d{3})*,\d{2}\s*(?:€|EUR)?(?:\s*\/\s*(?:stk|st|stück))?$|^-?\d+[.,]\d{2}\s*(?:€|EUR)?(?:\s*\/\s*(?:stk|st|stück))?$|^(?:€|EUR)\s*-?\d+[.,]\d{2}$/i;
const QTY_RE = /^(\d{1,3})(?:\s*(?:x|stk\.?|st\.?|stück|pcs))?$/i;
const HEADER_RE = /^(pos|artikel|bezeichnung|menge|preis|summe|gesamt|warenkorb|art\.?-?nr|zwischensumme|versand|mwst|ust|rabatt)/i;
const NOISE_RE = /^(inkl\.?|zzgl\.?|uvp|lieferbar|verfügbar|auf lager|lagernd|sofort|entfernen|löschen|merken|stk\.?|stück|x|€)$/i;

export function parseCart(lines) {
  const rows = [];
  for (const raw of (Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/))) {
    const line = String(raw || '').trim();
    if (!line || line.length < 3) continue;
    let cells = line.split(/\t|;|\s{2,}|\s\|\s|\|/).map((c) => c.trim()).filter(Boolean).filter(c => !NOISE_RE.test(c))
      // Listen-/Bruttopreise weglassen, Beschriftungen vor dem Einkaufspreis entfernen („EK 9,84 €“ → „9,84 €“)
      .filter(c => !/^(uvp|listenpreis|brutto|statt|vorher)\b/i.test(c))
      .map(c => c.replace(/^(ek|netto|nettopreis|ihr preis|einzelpreis|stückpreis|stueckpreis|preis|je|à|a)\s*:?\s*(?=-?\d)/i, '').replace(/\s*(inkl\.|zzgl\.).*$/i, '').trim())
      .filter(Boolean);
    if (!cells.length) continue;
    if (cells.length === 1) {
      let rest = cells[0]; const parts = [];
      const q = /^(\d{1,3})\s*(x|stk\.?|st\.?|stück)\s+/i.exec(rest); if (q) { parts.push(q[1]); rest = rest.slice(q[0].length); }
      const pr = /\s(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+\.\d{2})\s*(?:€|EUR)?$/i.exec(rest); if (pr) { rest = rest.slice(0, pr.index); }
      cells = [...parts, rest.trim(), ...(pr ? [pr[1]] : [])].filter(Boolean);
    }
    if (HEADER_RE.test(cells[0]) && !cells.some((c) => PRICE_RE.test(c))) continue;
    if (/^(zwischensumme|summe|gesamt|versand|mwst|ust|rabatt|gutschein)/i.test(cells[0])) continue;
    const used = new Set();
    const prices = [];
    cells.forEach((c, i) => { if (PRICE_RE.test(c)) { prices.push(parseMoney(c.replace(/\/.*$/, ''))); used.add(i); } });
    let quantity = null;
    cells.forEach((c, i) => { if (quantity == null && !used.has(i)) { const m = QTY_RE.exec(c); if (m && Number(m[1]) > 0 && Number(m[1]) < 500) { quantity = Number(m[1]); used.add(i); } } });
    let partNumber = '';
    cells.forEach((c, i) => {
      if (partNumber || used.has(i)) return;
      const m = /^(?:art(?:ikel)?\.?\s*-?\s*nr\.?|artikelnummer|teilenummer|best\.?-?nr\.?|bestellnummer|oe-?nr\.?|nr\.?)\s*:?\s*(.+)$/i.exec(c);
      if (m) { partNumber = m[1].trim(); used.add(i); return; }
      const compact = c.replace(/\s/g, '');
      if (/\d/.test(c) && compact.length >= 4 && c.length <= 30 && (c.match(/[A-Za-zÄÖÜäöü]/g) || []).length <= compact.length / 2) { partNumber = c; used.add(i); }
    });
    // „CASTROL 15669E“, „BOSCH 0 986 494 812“: Marke in Großbuchstaben + Nummer
    if (!partNumber) cells.forEach((c, i) => { if (!partNumber && !used.has(i) && /^[A-ZÄÖÜ][A-ZÄÖÜ&-]{1,20}\s+(?=[A-Z0-9 .\/-]*\d)[A-Z0-9][A-Z0-9 .\/-]{2,25}$/.test(c) && cells.filter((_, j) => !used.has(j) && j !== i).some(o => /[a-zäöüß]{3,}/.test(o))) { partNumber = c; used.add(i); } });
    const rest = cells.filter((_, i) => !used.has(i)).filter(c => /[a-zäöüß]{2,}/i.test(c));
    let name = rest.filter(c => !/^[A-ZÄÖÜ][A-ZÄÖÜ&-]{1,20}$/.test(c)).sort((a, b) => b.length - a.length)[0] || rest[0] || '';
    // Marke als eigene Zelle („RIDEX“) vor die Bezeichnung setzen
    const brand = cells.find((c, i) => !used.has(i) && /^[A-ZÄÖÜ][A-ZÄÖÜ&-]{1,20}$/.test(c) && c !== name);
    if (brand && name && !name.toUpperCase().includes(brand)) name = brand + ' ' + name;
    if (!name && !partNumber) continue;
    if (!prices.length && !partNumber && !quantity) continue; // Überschriften o. Ä.
    const qty = quantity || 1;
    let unit = prices.length ? prices[0] : null;
    if (prices.length >= 2) {
      const ps = prices.filter(p => p != null);
      // Einzelpreis × Menge = Gesamt: kleineren als Einzelpreis nehmen, wenn er passt
      const fit = ps.find(a => ps.some(b => b !== a && Math.abs(a * qty - b) < 0.02));
      if (fit != null) unit = fit;
      else if (qty === 1) unit = Math.min(...ps);
    }
    rows.push({ part_name: (name || partNumber).slice(0, 160), part_number: name ? partNumber.slice(0, 60) : '', quantity: qty, unit_price: unit == null ? null : round2(unit) });
  }
  return rows;
}

// Lieferant aus der Adresse der Seite
export function supplierFromHost(host) {
  const h = String(host || '').toLowerCase();
  if (/stahlgruber|stakis/.test(h)) return 'stakis';
  if (/(^|\.)wm\.de$|wm-?kat|trost/.test(h)) return 'wm';
  if (/coparts|pv-?automotive|pv-?online/.test(h)) return 'coparts';
  if (/autodoc/.test(h)) return 'autodoc';
  if (/kfzteile24/.test(h)) return 'kfzteile24';
  // Reifen-Großhändler
  if (/tyre24|alzura/.test(h)) return 'tyre24';
  if (/interpneu/.test(h)) return 'interpneu';
  if (/goeggel|göggel|xn--ggel/.test(h)) return 'goeggel';
  if (/gundlach/.test(h)) return 'gundlach';
  return 'sonstige';
}
export const SUPPLIER_NAMES = { stakis: 'Stahlgruber STAkis', wm: 'WM SE / Trost', coparts: 'PV Automotive / Coparts', autodoc: 'Autodoc', kfzteile24: 'kfzteile24', tyre24: 'Tyre24 / Alzura', interpneu: 'Interpneu', goeggel: 'Reifen Göggel', gundlach: 'Reifen Gundlach', sonstige: 'Sonstiger Lieferant' };
export const TIRE_SUPPLIERS = ['tyre24', 'interpneu', 'goeggel', 'gundlach'];
