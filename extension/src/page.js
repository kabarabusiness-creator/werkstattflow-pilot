// Diese Funktionen laufen in der Seite des Teilehändlers (per chrome.scripting, nur nach Klick auf die Erweiterung).
// Sie müssen in sich geschlossen sein – keine Variablen von außen verwenden.

// Warenkorb aus der aktuell geöffneten Seite lesen.
// 1. Ist Text markiert, wird genau der genommen.
// 2. Sonst: wiederkehrende Zeilen mit Preis suchen (Tabellen-Zeilen oder gleich aufgebaute Blöcke) – das ist bei
//    STAkis, WM, Coparts, Onlineshops fast immer der Warenkorb. Mengenfelder (input) werden mitgelesen.
// Ergebnis: Zeilen als Text mit Tabulator zwischen den Zellen – zerlegt wird im Popup (gleiche Regeln wie im Dashboard).
export function alReadPage() {
  const PRICE = /-?\d{1,3}(?:\.\d{3})*,\d{2}(?!\d)|-?\d+\.\d{2}(?!\d)/;
  const SKIP = /^(zwischensumme|summe|gesamt|gesamtsumme|total|versand|versandkosten|mwst|ust|mehrwertsteuer|rabatt|gutschein|nettobetrag|bruttobetrag|endbetrag|zahlbetrag)\b/i;
  const base = { host: location.hostname, title: document.title.slice(0, 120), url: location.href.slice(0, 300) };
  const selObj = window.getSelection ? window.getSelection() : null;
  const selText = String(selObj || '').trim();
  const useSel = selText.length >= 8 && selObj && selObj.rangeCount > 0;

  const visible = el => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const FORMAT = /^(B|STRONG|EM|I|U|SMALL|SUP|SUB|ABBR|MARK|FONT|CODE|BDI|Q|TIME)$/;
  // Zellen einer Zeile: Blöcke, Tabellenzellen und nebeneinanderstehende Spans werden zu eigenen Zellen,
  // Mengenfelder (input/select) liefern ihren Wert statt aller Auswahlmöglichkeiten.
  const cellsOf = (root) => {
    const out = []; let cur = '';
    const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) out.push(t); cur = ''; };
    const walk = (n) => {
      if (n.nodeType === 3) { cur += n.nodeValue.replace(/ /g, ' '); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|BUTTON|TEMPLATE|IMG)$/.test(tag)) return;
      if (tag === 'BR') { flush(); return; }
      if (n !== root && !visible(n) && tag !== 'OPTION') return;
      if (tag === 'SELECT') { flush(); const o = n.options[n.selectedIndex]; const t = o ? o.text.trim() : ''; if (t) out.push(/^\d{1,3}$/.test(t) ? t + ' Stk' : t); return; }
      if (tag === 'INPUT' || tag === 'TEXTAREA') { if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'image'].includes(n.type)) return; flush(); const v = String(n.value || '').trim(); if (/^\d{1,3}([.,]\d+)?$/.test(v)) out.push(v.replace(/[.,]0+$/, '') + ' Stk'); return; }
      const d = getComputedStyle(n).display;
      const inlineLike = d === 'inline' || d === 'contents';
      const boundary = n !== root && (!inlineLike || (!FORMAT.test(tag) && n.parentElement && n.parentElement.children.length >= 2 && tag !== 'A'));
      if (boundary) flush();
      for (const c of n.childNodes) walk(c);
      if (boundary) flush();
    };
    walk(root); flush();
    return out.filter(c => !/^(entfernen|löschen|loeschen|merken|ändern|aendern|details|in den warenkorb|×|x|\+|-|–)$/i.test(c));
  };
  const textOf = el => (el.innerText || el.textContent || '');
  const sig = el => el.tagName + '.' + String(el.className && el.className.baseVal != null ? el.className.baseVal : el.className || '').split(/\s+/).filter(c => c && !/(active|selected|odd|even|first|last|hover|focus|\d)/i.test(c)).sort().join('.');
  const ctxText = el => { let t = ''; let a = el; for (let i = 0; a && i < 6; i++, a = a.parentElement) t += ' ' + (a.id || '') + ' ' + (typeof a.className === 'string' ? a.className : ''); return t.toLowerCase(); };

  // sichtbare Elemente mit Preis im eigenen Text (bei Markierung nur innerhalb der Markierung)
  const priceEls = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; let guard = 0;
  while ((n = walker.nextNode()) && guard++ < 60000) {
    if (!PRICE.test(n.nodeValue || '')) continue;
    const el = n.parentElement; if (!el || !visible(el)) continue;
    if (el.closest('header, nav, footer, script, style, noscript')) continue;
    if (useSel && !selObj.containsNode(n, true)) continue;
    priceEls.push(el);
  }
  // Gruppen: gleich aufgebaute Geschwister mit Preis = Warenkorbzeilen
  const groups = new Map();
  for (const p of priceEls) {
    let a = p; let depth = 0;
    while (a && a.parentElement && a !== document.body && depth++ < 12) {
      const parent = a.parentElement;
      let g = groups.get(parent); if (!g) { g = new Map(); groups.set(parent, g); }
      const s = sig(a);
      if (!g.has(s)) g.set(s, new Set());
      g.get(s).add(a);
      a = parent;
    }
  }
  let best = null;
  for (const [parent, bySig] of groups) {
    for (const [, set] of bySig) {
      const rows = [...set].filter(r => visible(r) && /[a-zäöüß]{3,}/i.test(textOf(r)) && textOf(r).length < 1500);
      if (!rows.length) continue;
      const ctx = ctxText(parent);
      const cartHint = /warenkorb|einkaufswagen|basket|cart|bestellliste|bestellung|ordlist|orderlist|order-list|positions?/.test(ctx);
      const promo = /recommend|empfehl|zubeh|similar|aehnlich|auch|angebot|teaser|slider|carousel|swiper|banner|promo|related|cross|upsell/.test(ctx);
      if (rows.length < 2 && !cartHint && !useSel) continue;
      // Zeile darf nicht der ganze Warenkorb sein (mehrere Preise mit eigenen Zeilen darunter zählen trotzdem)
      const score = rows.length * 10 + (cartHint ? 15 : 0) - (promo ? 25 : 0) + (rows[0].tagName === 'TR' ? 5 : 0) - Math.max(0, rows.length - 80);
      if (!best || score > best.score) best = { score, rows };
    }
  }
  if (!best) {
    if (useSel) return { ...base, mode: 'auswahl', lines: [selText.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\t')] };
    return { ...base, mode: 'nichts', lines: [] };
  }
  const lines = best.rows
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map(r => cellsOf(r).join('\t')).filter(l => l && !SKIP.test(l.trim()));
  return { ...base, mode: useSel ? 'auswahl' : 'seite', lines: lines.slice(0, 200) };
}

// FIN oder HSN/TSN in die Suchfelder des Katalogs einsetzen (fokussiertes Feld oder passendes Suchfeld)
export function alFillVehicle(kind, vin, hsn, tsn) {
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly; };
  const inputs = [...document.querySelectorAll('input:not([type]), input[type=text], input[type=search]')].filter(visible);
  const hint = el => (el.name + ' ' + el.id + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.labels && el.labels[0] ? el.labels[0].innerText : '')).toLowerCase();
  const set = (el, v) => {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    el.focus(); proto.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const act = document.activeElement && document.activeElement.tagName === 'INPUT' && visible(document.activeElement) ? document.activeElement : null;
  if (kind === 'vin') {
    const el = act || inputs.find(i => /fin|vin|fahrgestell|chassis/.test(hint(i))) || inputs.find(i => /such|search|fahrzeug|vehicle/.test(hint(i)));
    if (!el) return { ok: false };
    set(el, vin); return { ok: true, field: hint(el).slice(0, 40) };
  }
  const h = inputs.find(i => /\bhsn\b|2\.1|herstellerschl/.test(hint(i)));
  const t = inputs.find(i => /\btsn\b|2\.2|typschl/.test(hint(i)));
  if (h && t) { set(h, hsn); set(t, tsn); return { ok: true, field: 'hsn+tsn' }; }
  const el = act || inputs.find(i => /kba|schl(ue|ü)ssel|hsn|tsn/.test(hint(i))) || inputs.find(i => /such|search|fahrzeug|vehicle/.test(hint(i)));
  if (!el) return { ok: false };
  set(el, `${hsn} ${tsn}`.trim()); return { ok: true, field: hint(el).slice(0, 40) };
}
