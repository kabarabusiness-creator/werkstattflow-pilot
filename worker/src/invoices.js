/**
 * Rechnungen nach GoBD: Ausstellen, Festschreiben, Stornieren, Archiv, Journal, Protokoll.
 *
 * - Der Server vergibt die Rechnungsnummer (fortlaufend je Werkstatt und Jahr, RE-JJJJ-NNN, auch Stornos).
 * - Beim Ausstellen werden Rechnungsdaten (JSON), PDF und XRechnung (XML) einmalig im Archiv (KV) abgelegt,
 *   jeweils mit SHA-256-Prüfwert. Archivdateien werden nie überschrieben oder gelöscht.
 * - Korrekturen nur per Stornorechnung (eigene Nummer, negative Beträge, Bezug auf das Original).
 * - Jede Aktion (Ausstellen, Storno, Zahlungsstatus, Abruf) wird mit Zeit und Person protokolliert.
 */
import { Pdf, A4, textWidth, wrapText } from './pdf.js';
import { count as countUsage } from './usage.js';
import { makeZip } from './zip.js';

export const INV_PREFIX = '_inv/';
export const INVLOG_PREFIX = '_invlog/';
const VAT_RATE = 0.19;
const KLEINBETRAG = 250; // bis 250 € brutto: Kleinbetragsrechnung (Empfängeranschrift nicht Pflicht)
const PAYMENT_STATUSES = ['offen', 'bezahlt', 'ueberfaellig', 'erstattet'];
const PAY_LABEL = { bar: 'Barzahlung', karte: 'Kartenzahlung', ueberweisung: 'Überweisung' };

const r2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const eur = v => (Number(v) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => (Number(v) || 0).toLocaleString('de-DE', { maximumFractionDigits: 3 });
const deDate = iso => { if (!iso) return ''; const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(iso); };
const berlinDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const addDays = (iso, days) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (Number(days) || 0)); return d.toISOString().slice(0, 10); };
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const codeOk = c => /^[A-Z0-9-]{2,40}$/.test(c);

// Je Werkstatt nur eine Rechnungsaktion gleichzeitig (pro Server-Instanz)
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const p = prev.catch(() => {}).then(fn);
  locks.set(key, p.catch(() => {}));
  return p;
}

async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function b64(bytes) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
// stabile JSON-Darstellung (sortierte Schlüssel) für den Prüfwert der Rechnungsdaten
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/* ---------- Berechnung ---------- */
export function computeTotals(items, kleinunternehmer) {
  const lines = items.map(it => ({ ...it, total: r2(Number(it.quantity) * Number(it.unit_price)) }));
  const net = r2(lines.reduce((s, it) => s + it.total, 0));
  const vat = kleinunternehmer ? 0 : r2(net * VAT_RATE);
  return { lines, totals: { net, vat, gross: r2(net + vat) } };
}
export function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).map(it => ({
    description: str(it && it.description, 500),
    item_type: ['leistung', 'ersatzteil', 'material', 'sonstiges'].includes(it && it.item_type) ? it.item_type : 'leistung',
    quantity: r2(Number(it && it.quantity)),
    unit_price: r2(Number(it && it.unit_price)),
    service_id: it && it.service_id ? str(it.service_id, 64) : undefined,
  })).filter(it => it.description && isFinite(it.quantity) && isFinite(it.unit_price) && it.quantity !== 0);
}
export function missingSellerFields(p) {
  const m = [];
  if (!p || !str(p.company_name)) m.push('Firmenname');
  if (!p || !str(p.address_street) || !str(p.address_zip) || !str(p.address_city)) m.push('Firmenanschrift');
  if (!p || (!str(p.steuernummer) && !str(p.ust_id))) m.push('Steuernummer oder USt-IdNr.');
  return m;
}

/* ---------- PDF ---------- */
const C = { ink: [0.11, 0.11, 0.18], muted: [0.42, 0.42, 0.5], faint: [0.62, 0.62, 0.68], accent: [0.43, 0.16, 0.85], line: [0.86, 0.86, 0.9], head: [0.95, 0.94, 0.98], red: [0.75, 0.12, 0.12] };

export function renderInvoicePdf(doc) {
  const s = doc.seller, b = doc.buyer, storno = doc.type === 'storno';
  const pdf = new Pdf({ title: `${storno ? 'Stornorechnung' : 'Rechnung'} ${doc.number}`, author: s.company_name, date: doc.issued_at });
  const L = 56, R = A4.w - 56, CW = R - L;
  let y;

  const header = () => {
    pdf.text(s.company_name, L, 64, { size: 15, bold: true, color: C.ink });
    let hy = 80;
    for (const t of [s.address_street, `${s.address_zip} ${s.address_city}`, s.phone ? `Tel. ${s.phone}` : '', s.email || ''].filter(Boolean)) { pdf.text(t, L, hy, { size: 9, color: C.muted }); hy += 12; }
    pdf.text(storno ? 'STORNORECHNUNG' : 'RECHNUNG', R, 66, { size: 17, bold: true, color: storno ? C.red : C.accent, align: 'right' });
    const meta = [['Rechnungsnummer', doc.number], ['Rechnungsdatum', deDate(doc.invoice_date)], ['Leistungsdatum', deDate(doc.service_date)]];
    if (doc.due_date && !storno) meta.push(['Zahlbar bis', deDate(doc.due_date)]);
    if (doc.order_number) meta.push(['Auftragsnummer', doc.order_number]);
    if (storno) meta.push(['Storno zu', doc.cancels]);
    let my = 84;
    for (const [k, v] of meta) { pdf.text(k + ':', R - 92, my, { size: 9, color: C.muted, align: 'right' }); pdf.text(String(v || '–'), R, my, { size: 9, bold: true, color: C.ink, align: 'right' }); my += 12; }
    return Math.max(hy, my);
  };
  const tableHead = ty => {
    pdf.rect(L, ty, CW, 20, { fill: C.head });
    const hy = ty + 13.5;
    pdf.text('Pos.', L + 6, hy, { size: 8.5, bold: true, color: C.muted });
    pdf.text('Beschreibung', L + 34, hy, { size: 8.5, bold: true, color: C.muted });
    pdf.text('Menge', R - 190, hy, { size: 8.5, bold: true, color: C.muted, align: 'right' });
    pdf.text('Einzelpreis netto', R - 92, hy, { size: 8.5, bold: true, color: C.muted, align: 'right' });
    pdf.text('Gesamt netto', R - 6, hy, { size: 8.5, bold: true, color: C.muted, align: 'right' });
    return ty + 28;
  };
  const BOTTOM = A4.h - 110;
  const newPage = () => { pdf.addPage(); y = header() + 24; y = tableHead(y); };

  y = header();
  // Absenderzeile + Empfänger
  y = Math.max(y + 22, 160);
  pdf.text([s.company_name, s.address_street, `${s.address_zip} ${s.address_city}`].filter(Boolean).join(' · '), L, y, { size: 7, color: C.faint });
  y += 16;
  for (const [i, t] of [b.name, b.street, [b.zip, b.city].filter(Boolean).join(' ')].filter(Boolean).entries()) { pdf.text(t, L, y, { size: 10.5, bold: i === 0, color: C.ink }); y += 14; }
  y += 18;

  if (storno) {
    pdf.text(`Stornierung der Rechnung ${doc.cancels} vom ${deDate(doc.cancels_date)}`, L, y, { size: 11, bold: true, color: C.red }); y += 14;
    if (doc.reason) { for (const ln of wrapText('Grund: ' + doc.reason, CW, 9.5)) { pdf.text(ln, L, y, { size: 9.5, color: C.muted }); y += 12; } }
    y += 6;
  }
  const v = doc.vehicle || {};
  const veh = [[v.brand, v.model].filter(Boolean).join(' '), v.plate ? `Kennzeichen ${v.plate}` : '', v.vin ? `FIN ${v.vin}` : '', v.mileage ? `km-Stand ${num(v.mileage)}` : ''].filter(Boolean).join(' · ');
  if (veh) { pdf.text('Fahrzeug: ' + veh, L, y, { size: 9.5, color: C.muted }); y += 18; }

  y = tableHead(y);
  doc.items.forEach((it, i) => {
    const desc = wrapText(it.description, R - 210 - (L + 34), 9.5);
    const h = desc.length * 12 + 12;
    if (y + h > BOTTOM) newPage();
    pdf.text(String(i + 1), L + 6, y, { size: 9.5, color: C.muted });
    desc.forEach((ln, j) => pdf.text(ln, L + 34, y + j * 12, { size: 9.5, color: C.ink }));
    pdf.text(num(it.quantity), R - 190, y, { size: 9.5, align: 'right', color: C.ink });
    pdf.text(eur(it.unit_price) + ' €', R - 92, y, { size: 9.5, align: 'right', color: C.ink });
    pdf.text(eur(it.total) + ' €', R - 6, y, { size: 9.5, align: 'right', color: C.ink });
    const ly = y + (desc.length - 1) * 12 + 6;
    pdf.line(L, ly, R, ly, { color: C.line, width: 0.5 });
    y += h;
  });

  // Summen
  const sumRows = [['Summe netto', doc.totals.net]];
  if (!doc.kleinunternehmer) sumRows.push([`zzgl. ${Math.round(doc.vat_rate * 100)} % USt. auf ${eur(doc.totals.net)} €`, doc.totals.vat]);
  if (y + 30 + sumRows.length * 15 > BOTTOM) newPage();
  y += 8;
  for (const [k, val] of sumRows) { pdf.text(k, R - 120, y, { size: 9.5, color: C.muted, align: 'right' }); pdf.text(eur(val) + ' €', R - 6, y, { size: 9.5, align: 'right', color: C.ink }); y += 15; }
  pdf.line(R - 250, y - 9, R, y - 9, { color: C.ink, width: 0.8 });
  pdf.text(storno ? 'Gutschrift gesamt' : 'Gesamtbetrag', R - 120, y + 4, { size: 11, bold: true, align: 'right', color: C.ink });
  pdf.text(eur(doc.totals.gross) + ' €', R - 6, y + 4, { size: 11, bold: true, align: 'right', color: C.ink });
  y += 28;

  const notes = [];
  if (doc.kleinunternehmer) notes.push('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).');
  if (!storno) {
    notes.push(`Zahlungsart: ${PAY_LABEL[doc.payment_method] || doc.payment_method || '–'}.` + (doc.payment_method === 'ueberweisung' && doc.due_date ? ` Bitte überweisen Sie den Betrag bis zum ${deDate(doc.due_date)} unter Angabe der Rechnungsnummer.` : ''));
    notes.push('Vielen Dank für Ihren Auftrag!');
  } else {
    notes.push(`Diese Stornorechnung hebt die Rechnung ${doc.cancels} vollständig auf.`);
  }
  for (const nt of notes) for (const ln of wrapText(nt, CW, 9.5)) { if (y > BOTTOM) newPage(); pdf.text(ln, L, y, { size: 9.5, color: C.ink }); y += 13; }

  // Fußzeile auf jeder Seite
  const total = pdf.pages.length;
  const col1 = [s.company_name, s.address_street, `${s.address_zip} ${s.address_city}`].filter(Boolean);
  const col2 = s.bank_iban ? [s.bank_name || 'Bankverbindung', `IBAN ${s.bank_iban}`, s.bank_bic ? `BIC ${s.bank_bic}` : ''].filter(Boolean) : [];
  const col3 = [s.steuernummer ? `Steuernr. ${s.steuernummer}` : '', s.ust_id ? `USt-IdNr. ${s.ust_id}` : '', s.email || ''].filter(Boolean);
  for (let p = 0; p < total; p++) {
    pdf.setPage(p);
    const fy = A4.h - 78;
    pdf.line(L, fy - 12, R, fy - 12, { color: C.line, width: 0.6 });
    [col1, col2, col3].forEach((col, ci) => col.forEach((t, i) => pdf.text(t, L + ci * (CW / 3), fy + i * 10, { size: 7.5, color: C.muted })));
    pdf.text(`Festgeschrieben am ${deDate(doc.issued_at.slice(0, 10))} · Prüfwert ${doc.sha_record.slice(0, 16)}`, L, A4.h - 30, { size: 6.5, color: C.faint });
    pdf.text(`Seite ${p + 1} von ${total}`, R, A4.h - 30, { size: 7, color: C.faint, align: 'right' });
  }
  return pdf.output();
}

/* ---------- XRechnung 3.0 (UBL 2.1, EN 16931) ---------- */
const x = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const amt = v => r2(v).toFixed(2);
export function renderXRechnung(doc) {
  const s = doc.seller, b = doc.buyer, ku = doc.kleinunternehmer;
  const cat = ku ? 'E' : 'S', pct = ku ? 0 : Math.round(doc.vat_rate * 100);
  const party = (tag, p, seller) => [
    `  <cac:${tag}>`, `    <cac:Party>`,
    p.email ? `      <cbc:EndpointID schemeID="EM">${x(p.email)}</cbc:EndpointID>` : '',
    `      <cac:PartyName><cbc:Name>${x(p.name)}</cbc:Name></cac:PartyName>`,
    `      <cac:PostalAddress>`,
    p.street ? `        <cbc:StreetName>${x(p.street)}</cbc:StreetName>` : '',
    p.city ? `        <cbc:CityName>${x(p.city)}</cbc:CityName>` : '',
    p.zip ? `        <cbc:PostalZone>${x(p.zip)}</cbc:PostalZone>` : '',
    `        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>`, `      </cac:PostalAddress>`,
    seller && p.ust_id ? `      <cac:PartyTaxScheme><cbc:CompanyID>${x(p.ust_id)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '',
    seller && p.steuernummer ? `      <cac:PartyTaxScheme><cbc:CompanyID>${x(p.steuernummer)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>FC</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : '',
    `      <cac:PartyLegalEntity><cbc:RegistrationName>${x(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>`,
    seller ? `      <cac:Contact><cbc:Name>${x(p.contact || p.name)}</cbc:Name><cbc:Telephone>${x(p.phone || '-')}</cbc:Telephone><cbc:ElectronicMail>${x(p.email || '-')}</cbc:ElectronicMail></cac:Contact>` : '',
    `    </cac:Party>`, `  </cac:${tag}>`,
  ].filter(Boolean).join('\n');
  const taxCat = `<cac:TaxCategory><cbc:ID>${cat}</cbc:ID><cbc:Percent>${pct}</cbc:Percent>${ku ? '<cbc:TaxExemptionReason>Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG</cbc:TaxExemptionReason>' : ''}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>`;
  const payCode = doc.payment_method === 'ueberweisung' ? '58' : doc.payment_method === 'karte' ? '54' : '10';
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`,
    `  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>`,
    `  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>`,
    `  <cbc:ID>${x(doc.number)}</cbc:ID>`,
    `  <cbc:IssueDate>${x(doc.invoice_date)}</cbc:IssueDate>`,
    doc.due_date && doc.type !== 'storno' ? `  <cbc:DueDate>${x(doc.due_date)}</cbc:DueDate>` : '',
    `  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>`,
    doc.type === 'storno' ? `  <cbc:Note>Stornorechnung zu ${x(doc.cancels)}${doc.reason ? ' – ' + x(doc.reason) : ''}</cbc:Note>` : '',
    ku ? `  <cbc:Note>Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.</cbc:Note>` : '',
    `  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>`,
    `  <cbc:BuyerReference>${x(doc.order_number || doc.number)}</cbc:BuyerReference>`,
    doc.type === 'storno' ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${x(doc.cancels)}</cbc:ID>${doc.cancels_date ? `<cbc:IssueDate>${x(doc.cancels_date)}</cbc:IssueDate>` : ''}</cac:InvoiceDocumentReference></cac:BillingReference>` : '',
    party('AccountingSupplierParty', { name: s.company_name, street: s.address_street, zip: s.address_zip, city: s.address_city, email: s.email, phone: s.phone, contact: s.contact_name, ust_id: s.ust_id, steuernummer: s.steuernummer }, true),
    party('AccountingCustomerParty', { name: b.name, street: b.street, zip: b.zip, city: b.city, email: b.email }, false),
    doc.service_date ? `  <cac:Delivery><cbc:ActualDeliveryDate>${x(doc.service_date)}</cbc:ActualDeliveryDate></cac:Delivery>` : '',
    `  <cac:PaymentMeans><cbc:PaymentMeansCode>${payCode}</cbc:PaymentMeansCode><cbc:PaymentID>${x(doc.number)}</cbc:PaymentID>${s.bank_iban && payCode === '58' ? `<cac:PayeeFinancialAccount><cbc:ID>${x(String(s.bank_iban).replace(/\s+/g, ''))}</cbc:ID>${s.bank_name ? `<cbc:Name>${x(s.bank_name)}</cbc:Name>` : ''}${s.bank_bic ? `<cac:FinancialInstitutionBranch><cbc:ID>${x(s.bank_bic)}</cbc:ID></cac:FinancialInstitutionBranch>` : ''}</cac:PayeeFinancialAccount>` : ''}</cac:PaymentMeans>`,
    `  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">${amt(doc.totals.vat)}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">${amt(doc.totals.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">${amt(doc.totals.vat)}</cbc:TaxAmount>${taxCat}</cac:TaxSubtotal></cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">${amt(doc.totals.net)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">${amt(doc.totals.net)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">${amt(doc.totals.gross)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">${amt(doc.totals.gross)}</cbc:PayableAmount></cac:LegalMonetaryTotal>`,
    ...doc.items.map((it, i) => `  <cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">${r2(it.quantity)}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">${amt(it.total)}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${x(it.description.slice(0, 200))}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${cat}</cbc:ID><cbc:Percent>${pct}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">${amt(Math.abs(it.unit_price))}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`),
    `</Invoice>`,
  ].filter(Boolean).join('\n');
}

/* ---------- Archiv & Journal (KV) ---------- */
const docKey = (code, number, ext) => `${INV_PREFIX}${code}/${number}.${ext}`;
const indexKey = code => `${INV_PREFIX}${code}/_index`;
async function readIndex(env, code) { return (await env.PHOTOS.get(indexKey(code), { type: 'json' })) || []; }
async function writeIndex(env, code, list) { await env.PHOTOS.put(indexKey(code), JSON.stringify(list)); countUsage('kv_writes'); }
async function putOnce(env, key, value, meta) {
  if (await env.PHOTOS.get(key, { type: 'arrayBuffer' })) throw new Error('archive_exists:' + key);
  await env.PHOTOS.put(key, value, { metadata: meta });
  countUsage('kv_writes');
  await mirrorToR2(env, key, value, meta);
}
export async function logEvent(env, code, event, user, detail) {
  const at = new Date().toISOString();
  const rnd = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `${INVLOG_PREFIX}${code}/${at}_${rnd}`, value = JSON.stringify({ at, event, by: user ? { id: user.id, name: user.name, email: user.email } : null, ...detail });
  await env.PHOTOS.put(key, value);
  countUsage('kv_writes');
  if (event !== 'abgerufen') await mirrorToR2(env, key, value, { contentType: 'application/json' });
}
async function readLog(env, code, number) {
  const out = []; let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await env.PHOTOS.list({ prefix: `${INVLOG_PREFIX}${code}/`, cursor, limit: 1000 });
    out.push(...r.keys.map(k => k.name)); if (r.list_complete) break; cursor = r.cursor;
  }
  const keys = out.sort().reverse().slice(0, 400);
  const rows = await Promise.all(keys.map(k => env.PHOTOS.get(k, { type: 'json' }).catch(() => null)));
  return rows.filter(Boolean).filter(r => !number || r.number === number || r.cancels === number);
}

// höchste vergebene Nummer: aus Base44 (sofort konsistent) und dem Journal
function nextNumber(orders, index, year) {
  const prefix = `RE-${year}-`;
  let max = 0;
  const see = n => { const m = new RegExp(`^RE-${year}-(\\d+)$`).exec(String(n || '')); if (m) max = Math.max(max, parseInt(m[1], 10)); };
  for (const o of orders) { see(o.invoice_number); (Array.isArray(o.invoice_history) ? o.invoice_history : []).forEach(hh => { see(hh && hh.number); see(hh && hh.storno_number); }); }
  index.forEach(e => see(e.number));
  return prefix + String(max + 1).padStart(3, '0');
}

function sellerSnapshot(p) {
  const keys = ['company_name', 'address_street', 'address_zip', 'address_city', 'phone', 'email', 'contact_name', 'steuernummer', 'ust_id', 'bank_name', 'bank_iban', 'bank_bic'];
  return Object.fromEntries(keys.map(k => [k, str(p[k])]));
}

/* ---------- Zweitarchiv in Cloudflare R2 (mit Bucket-Sperre: niemand kann löschen oder überschreiben) ---------- */
const r2Key = kvKey => kvKey.startsWith(INV_PREFIX) ? kvKey.slice(INV_PREFIX.length).replace(/^([^/]+)\/(RE-(\d{4})-[^/]+)$/, '$1/$3/$2') : 'protokoll/' + kvKey.slice(INVLOG_PREFIX.length) + '.json';
export async function mirrorToR2(env, kvKey, value, meta) {
  if (!env.INVOICE_ARCHIVE) return false;
  try {
    const r = await env.INVOICE_ARCHIVE.put(r2Key(kvKey), value, {
      onlyIf: new Headers({ 'If-None-Match': '*' }), // nur neu anlegen, nie überschreiben
      httpMetadata: { contentType: (meta && meta.contentType) || 'application/octet-stream' },
      customMetadata: meta && meta.sha256 ? { sha256: meta.sha256 } : {},
    });
    return r !== null;
  } catch (e) { console.log('r2_mirror', kvKey, String(e)); return false; }
}
// Nachtlauf: alles, was im Archiv (KV) liegt, aber noch nicht in R2, nachtragen
export async function syncInvoiceMirror(env, max = 400) {
  if (!env.INVOICE_ARCHIVE || !env.PHOTOS) return { configured: !!env.INVOICE_ARCHIVE, copied: 0 };
  let copied = 0, checked = 0;
  for (const prefix of [INV_PREFIX, INVLOG_PREFIX]) {
    let cursor;
    do {
      const r = await env.PHOTOS.list({ prefix, cursor, limit: 1000 });
      for (const k of r.keys) {
        if (k.name.endsWith('/_index')) continue;
        checked++;
        if (await env.INVOICE_ARCHIVE.head(r2Key(k.name))) continue;
        const obj = await env.PHOTOS.getWithMetadata(k.name, { type: 'arrayBuffer' });
        if (obj && obj.value && await mirrorToR2(env, k.name, obj.value, obj.metadata || { contentType: 'application/json' })) copied++;
        if (copied >= max) return { configured: true, copied, checked, incomplete: true };
      }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
  }
  return { configured: true, copied, checked };
}

async function archiveDoc(env, code, raw) {
  const doc = JSON.parse(JSON.stringify(raw)); // ohne undefined-Felder, damit der Prüfwert nach dem Speichern gleich bleibt
  const record = { ...doc };
  record.sha_record = await sha256(canon(doc));
  const pdf = renderInvoicePdf(record);
  const xml = renderXRechnung(record);
  record.sha_pdf = await sha256(pdf);
  record.sha_xml = await sha256(xml);
  await putOnce(env, docKey(code, doc.number, 'json'), JSON.stringify(record), { contentType: 'application/json', sha256: record.sha_record });
  await putOnce(env, docKey(code, doc.number, 'pdf'), pdf, { contentType: 'application/pdf', sha256: record.sha_pdf });
  await putOnce(env, docKey(code, doc.number, 'xml'), xml, { contentType: 'application/xml', sha256: record.sha_xml });
  return record;
}
const indexEntry = (r, extra) => ({
  number: r.number, type: r.type, order_id: r.order_id, order_number: r.order_number || '', customer: r.buyer.name, plate: (r.vehicle && r.vehicle.plate) || '',
  invoice_date: r.invoice_date, service_date: r.service_date, due_date: r.due_date || null, net: r.totals.net, vat: r.totals.vat, gross: r.totals.gross,
  payment_method: r.payment_method, payment_status: r.type === 'storno' ? null : 'offen', status: 'gueltig', cancels: r.cancels || null, cancelled_by: null,
  issued_at: r.issued_at, issued_by: r.issued_by && r.issued_by.name, kleinunternehmer: r.kleinunternehmer, legacy: !!r.legacy, sha_record: r.sha_record, ...extra,
});

/* ---------- Funktionen für das Dashboard ---------- */
export async function handleInvoice(name, body, c) {
  const { db, env, user, HttpError } = c;
  if (!env.PHOTOS) throw new HttpError(503, 'not_available', { message: 'Archiv-Speicher ist nicht eingerichtet.' });

  // Werkstatt des Nutzers: eigener Code oder Inhaber der Werkstatt
  async function myCodes() {
    const codes = new Set();
    if (user.workshop_code) codes.add(String(user.workshop_code).toUpperCase());
    const owned = await db.list('Workshop', { owner_user_id: user.id }, { limit: 20 }).catch(() => []);
    owned.forEach(w => w.code && codes.add(String(w.code).toUpperCase()));
    return codes;
  }
  async function orderFor(id) {
    let o = null;
    try { o = await db.get('Order', String(id || '')); } catch (e) { if (!(e.extra && e.extra.upstream === 404)) throw e; }
    if (!o) throw new HttpError(404, 'not_found', { message: 'Auftrag nicht gefunden.' });
    const code = String(o.workshop_code || '').toUpperCase();
    if (!codeOk(code)) throw new HttpError(400, 'no_workshop', { message: 'Auftrag ist keiner Werkstatt zugeordnet.' });
    if (!(await myCodes()).has(code)) throw new HttpError(403, 'forbidden');
    return { order: o, code };
  }
  async function codeFor(bodyCode) {
    const codes = await myCodes();
    const want = String(bodyCode || '').toUpperCase();
    if (want) { if (!codes.has(want)) throw new HttpError(403, 'forbidden'); return want; }
    const first = [...codes][0];
    if (!first) throw new HttpError(400, 'no_workshop', { message: 'Kein Werkstatt-Code hinterlegt.' });
    return first;
  }
  async function profileFor(code) {
    const list = await db.list('WorkshopProfile', { workshop_code: code }, { limit: 5 });
    return list[0] || {};
  }
  const who = { id: user.id, name: user.name || user.email || '', email: user.email || '' };

  /* Rechnung ausstellen (oder bestehende Alt-Rechnung nachträglich festschreiben) */
  if (name === 'invoiceIssue') {
    const { order, code } = await orderFor(body.order_id);
    return withLock(code, async () => {
      const index = await readIndex(env, code);
      const active = index.find(e => e.order_id === order.id && e.type === 'rechnung' && e.status === 'gueltig');
      if (active) {
        // schon ausgestellt (z. B. Wiederholung nach Verbindungsfehler) → Auftrag nur angleichen
        if (order.invoice_number !== active.number) await db.update('Order', order.id, { invoice_number: active.number, invoice_date: active.invoice_date, total_amount: active.gross, invoice_locked: true });
        return { ok: true, already: true, invoice: active };
      }
      const profile = await profileFor(code);
      const missing = missingSellerFields(profile);
      if (missing.length) throw new HttpError(400, 'seller_incomplete', { message: `Firmendaten unvollständig: ${missing.join(', ')}. Bitte unter „Firmendaten“ ergänzen.` });
      const legacy = !!order.invoice_number;
      let items;
      if (legacy) items = cleanItems(await db.list('InvoiceItem', { order_id: order.id }, { limit: 500 }));
      else items = cleanItems(body.items);
      if (!items.length) throw new HttpError(400, 'no_items', { message: 'Bitte mindestens eine Position mit Bezeichnung, Menge und Preis eingeben.' });
      let kleinunternehmer = !!profile.kleinunternehmer;
      if (legacy && Number(order.total_amount) > 0) {
        // Alt-Rechnung: Steuer so übernehmen, wie sie damals berechnet wurde (Betrag am Auftrag), nicht nach heutigen Firmendaten
        const net = computeTotals(items, true).totals.net;
        if (Math.abs(Number(order.total_amount) - net) < 0.02) kleinunternehmer = true;
        else if (Math.abs(Number(order.total_amount) - r2(net * (1 + VAT_RATE))) < 0.02) kleinunternehmer = false;
      }
      const { lines, totals } = computeTotals(items, kleinunternehmer);
      if (totals.gross <= 0) throw new HttpError(400, 'amount', { message: 'Der Rechnungsbetrag muss größer als 0 € sein.' });
      const billing = legacy ? { street: order.billing_street, zip: order.billing_zip, city: order.billing_city } : (body.billing || {});
      const buyer = { name: str(order.customer_name), street: str(billing.street), zip: str(billing.zip, 12), city: str(billing.city), email: str(order.email) };
      if (!buyer.name) throw new HttpError(400, 'buyer', { message: 'Kundenname fehlt.' });
      if (totals.gross > KLEINBETRAG && (!buyer.street || !buyer.zip || !buyer.city)) throw new HttpError(400, 'buyer_address', { message: 'Ab 250 € brutto muss die vollständige Rechnungsadresse des Kunden angegeben werden.' });
      const today = berlinDay();
      const invoiceDate = legacy && isDay(String(order.invoice_date || '').slice(0, 10)) ? String(order.invoice_date).slice(0, 10) : today;
      const serviceDate = isDay(body.service_date) ? body.service_date : (isDay(String(order.service_date || '').slice(0, 10)) ? String(order.service_date).slice(0, 10) : invoiceDate);
      const paymentMethod = ['bar', 'karte', 'ueberweisung'].includes(body.payment_method) ? body.payment_method : (order.payment_method || 'bar');
      const dueDays = Math.max(0, Math.min(120, Number(body.due_days != null ? body.due_days : (order.payment_due_days != null ? order.payment_due_days : profile.default_payment_due_days || 14)) || 0));
      let number;
      if (legacy) {
        number = String(order.invoice_number);
        if (index.some(e => e.number === number)) throw new HttpError(409, 'duplicate_number', { message: `Rechnungsnummer ${number} ist bereits im Archiv.` });
      } else {
        const orders = await db.list('Order', { workshop_code: order.workshop_code });
        number = nextNumber(orders, index, today.slice(0, 4));
      }
      const doc = {
        v: 1, type: 'rechnung', number, workshop_code: code, order_id: order.id, order_number: str(order.order_number, 40),
        invoice_date: invoiceDate, service_date: serviceDate, due_date: addDays(invoiceDate, dueDays), payment_method: paymentMethod, due_days: dueDays,
        seller: sellerSnapshot(profile), buyer,
        vehicle: { brand: str(order.vehicle_brand), model: str(order.vehicle_model), plate: str(order.license_plate, 20), vin: str(order.vin, 20), mileage: Number(order.mileage) || null },
        items: lines.map(({ service_id, ...it }) => it), totals, vat_rate: kleinunternehmer ? 0 : VAT_RATE, kleinunternehmer,
        issued_at: new Date().toISOString(), issued_by: who, legacy: legacy || undefined,
      };
      if (legacy) doc.legacy_note = 'Rechnung wurde vor Einführung des Archivs erstellt und nachträglich festgeschrieben.';
      const record = await archiveDoc(env, code, doc);
      index.push(indexEntry(record, { payment_status: legacy ? (order.payment_status || 'offen') : 'offen' }));
      await writeIndex(env, code, index);
      // Auftrag in Base44 aktualisieren (Anzeige im Dashboard)
      await db.update('Order', order.id, {
        invoice_number: number, invoice_date: invoiceDate, service_date: serviceDate,
        billing_street: buyer.street || undefined, billing_zip: buyer.zip || undefined, billing_city: buyer.city || undefined,
        payment_method: paymentMethod, payment_due_days: dueDays, payment_due_date: doc.due_date, total_amount: totals.gross,
        ...(legacy ? {} : { payment_status: 'offen' }), invoice_locked: true,
      });
      if (!legacy) {
        // Positionen am Auftrag = festgeschriebene Positionen
        const old = await db.list('InvoiceItem', { order_id: order.id }, { limit: 500 });
        for (const it of old) await db.remove('InvoiceItem', it.id).catch(() => {});
        for (const it of lines) await db.create('InvoiceItem', { order_id: order.id, description: it.description, item_type: it.item_type, quantity: it.quantity, unit_price: it.unit_price, total: it.total, workshop_code: order.workshop_code, ...(it.service_id ? { service_id: it.service_id } : {}) });
      }
      await logEvent(env, code, legacy ? 'nachtraeglich_festgeschrieben' : 'ausgestellt', who, { number, order_id: order.id, gross: totals.gross });
      return { ok: true, invoice: index[index.length - 1] };
    });
  }

  /* Stornorechnung */
  if (name === 'invoiceCancel') {
    const { order, code } = await orderFor(body.order_id);
    const reason = str(body.reason, 300);
    if (reason.length < 3) throw new HttpError(400, 'reason', { message: 'Bitte einen Grund für das Storno angeben.' });
    return withLock(code, async () => {
      const index = await readIndex(env, code);
      const orig = index.find(e => e.number === str(body.number || order.invoice_number, 40) && e.type === 'rechnung');
      if (!orig) throw new HttpError(404, 'not_archived', { message: 'Diese Rechnung ist noch nicht festgeschrieben. Bitte zuerst „Festschreiben“.' });
      if (orig.order_id !== order.id) throw new HttpError(400, 'mismatch');
      if (orig.status === 'storniert') throw new HttpError(409, 'already_cancelled', { message: `Rechnung ${orig.number} ist bereits storniert (${orig.cancelled_by}).` });
      const origDoc = await env.PHOTOS.get(docKey(code, orig.number, 'json'), { type: 'json' });
      if (!origDoc) throw new HttpError(500, 'archive_missing');
      const today = berlinDay();
      const orders = await db.list('Order', { workshop_code: order.workshop_code });
      const number = nextNumber(orders, index, today.slice(0, 4));
      const items = origDoc.items.map(it => ({ ...it, quantity: -it.quantity, total: r2(-it.total) }));
      const doc = {
        v: 1, type: 'storno', number, workshop_code: code, order_id: order.id, order_number: origDoc.order_number,
        invoice_date: today, service_date: origDoc.service_date, due_date: null, payment_method: origDoc.payment_method,
        seller: origDoc.seller, buyer: origDoc.buyer, vehicle: origDoc.vehicle, items,
        totals: { net: r2(-origDoc.totals.net), vat: r2(-origDoc.totals.vat), gross: r2(-origDoc.totals.gross) },
        vat_rate: origDoc.vat_rate, kleinunternehmer: origDoc.kleinunternehmer,
        cancels: orig.number, cancels_date: origDoc.invoice_date, reason,
        issued_at: new Date().toISOString(), issued_by: who,
      };
      const record = await archiveDoc(env, code, doc);
      orig.status = 'storniert'; orig.cancelled_by = number; orig.cancelled_at = record.issued_at;
      index.push(indexEntry(record, {}));
      await writeIndex(env, code, index);
      const history = Array.isArray(order.invoice_history) ? order.invoice_history.slice(-50) : [];
      history.push({ number: orig.number, date: orig.invoice_date, gross: orig.gross, storno_number: number, storno_date: today, reason });
      // Auftrag wieder abrechenbar machen – die Positionen bleiben zum Korrigieren erhalten
      await db.update('Order', order.id, { invoice_number: '', invoice_date: null, total_amount: null, invoice_locked: false, invoice_history: history });
      await logEvent(env, code, 'storniert', who, { number, cancels: orig.number, order_id: order.id, reason, gross: record.totals.gross });
      return { ok: true, storno: index[index.length - 1] };
    });
  }

  /* Zahlungsstatus (wird protokolliert) */
  if (name === 'invoiceSetPayment') {
    const { order, code } = await orderFor(body.order_id);
    const status = String(body.payment_status || '');
    if (!PAYMENT_STATUSES.includes(status)) throw new HttpError(400, 'params');
    return withLock(code, async () => {
      const index = await readIndex(env, code);
      const e = index.find(x => x.order_id === order.id && x.type === 'rechnung' && x.status === 'gueltig');
      const before = order.payment_status || 'offen';
      if (e) { e.payment_status = status; e.payment_changed_at = new Date().toISOString(); await writeIndex(env, code, index); }
      await db.update('Order', order.id, { payment_status: status });
      if (before !== status) await logEvent(env, code, 'zahlungsstatus', who, { number: order.invoice_number || null, order_id: order.id, from: before, to: status });
      return { ok: true };
    });
  }

  /* Rechnungsausgangsbuch (Journal) */
  if (name === 'invoiceJournal') {
    const code = await codeFor(body.workshop_code);
    const index = await readIndex(env, code);
    const archived = new Set(index.map(e => e.number));
    const orders = await db.list('Order', { workshop_code: code });
    const legacy = orders.filter(o => o.invoice_number && !archived.has(o.invoice_number))
      .map(o => ({ number: o.invoice_number, order_id: o.id, customer: o.customer_name, invoice_date: o.invoice_date, gross: o.total_amount, not_archived: true }));
    const profile = await profileFor(code);
    return { ok: true, workshop_code: code, entries: index.slice().reverse(), not_archived: legacy, kleinunternehmer: !!profile.kleinunternehmer };
  }

  /* Protokoll */
  if (name === 'invoiceLog') {
    const code = await codeFor(body.workshop_code);
    return { ok: true, events: await readLog(env, code, body.number ? str(body.number, 40) : '') };
  }

  /* Archiviertes Dokument abrufen (PDF / XRechnung / Daten) – mit Echtheitsprüfung */
  if (name === 'invoiceDocument') {
    const code = await codeFor(body.workshop_code);
    const number = str(body.number, 40);
    const fmt = ['pdf', 'xml', 'json'].includes(body.format) ? body.format : 'pdf';
    if (!/^[A-Z0-9-]{3,40}$/i.test(number)) throw new HttpError(400, 'params');
    const obj = await env.PHOTOS.getWithMetadata(docKey(code, number, fmt), { type: 'arrayBuffer' });
    if (!obj || !obj.value) throw new HttpError(404, 'not_found', { message: 'Dokument nicht im Archiv.' });
    const bytes = new Uint8Array(obj.value);
    const hash = await sha256(fmt === 'json' ? canon((({ sha_record, sha_pdf, sha_xml, ...rest }) => rest)(JSON.parse(new TextDecoder().decode(bytes)))) : bytes);
    const expected = obj.metadata && obj.metadata.sha256;
    if (body.log !== false) await logEvent(env, code, 'abgerufen', who, { number, format: fmt });
    return {
      ok: true, number, format: fmt, filename: `${number}.${fmt}`,
      content_type: fmt === 'pdf' ? 'application/pdf' : fmt === 'xml' ? 'application/xml' : 'application/json',
      data_base64: b64(bytes), sha256: hash, verified: !!expected && hash === expected,
    };
  }

  /* Komplettes Archiv eines Jahres als ZIP (Betriebsprüfung, Steuerberater, Kündigung) */
  if (name === 'invoiceExport') {
    const code = await codeFor(body.workshop_code);
    const year = /^\d{4}$/.test(String(body.year)) ? String(body.year) : berlinDay().slice(0, 4);
    const index = (await readIndex(env, code)).filter(e => String(e.invoice_date || '').startsWith(year)).sort((a, b) => String(a.number).localeCompare(String(b.number)));
    if (!index.length) throw new HttpError(404, 'empty', { message: `Keine Rechnungen in ${year}.` });
    const files = [], sums = [];
    for (const e of index) {
      for (const [ext, dir] of [['pdf', 'Rechnungen-PDF'], ['xml', 'XRechnung'], ['json', 'Rechnungsdaten']]) {
        const obj = await env.PHOTOS.getWithMetadata(docKey(code, e.number, ext), { type: 'arrayBuffer' });
        if (!obj || !obj.value) continue;
        const data = new Uint8Array(obj.value);
        const name = `${dir}/${e.number}${e.type === 'storno' ? '_Storno' : ''}.${ext}`;
        files.push({ name, data, date: new Date(e.issued_at || Date.now()) });
        sums.push(`${await sha256(data)}  ${name}`);
      }
    }
    const q = v => { const t = String(v == null ? '' : v); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const de = v => (Number(v) || 0).toFixed(2).replace('.', ',');
    const journal = [['Rechnungsnummer', 'Art', 'Rechnungsdatum', 'Leistungsdatum', 'Kunde', 'Kennzeichen', 'Netto', 'USt', 'Brutto', 'Zahlungsart', 'Zahlungsstatus', 'Status', 'Storno zu', 'Storniert durch', 'Ausgestellt am', 'Ausgestellt von', 'Prüfwert Rechnungsdaten (SHA-256)'].join(';'),
      ...index.map(e => [e.number, e.type === 'storno' ? 'Storno' : 'Rechnung', deDate(e.invoice_date), deDate(e.service_date), e.customer, e.plate, de(e.net), de(e.vat), de(e.gross), PAY_LABEL[e.payment_method] || e.payment_method, e.payment_status || '', e.status, e.cancels || '', e.cancelled_by || '', e.issued_at, e.issued_by || '', e.sha_record].map(q).join(';'))].join('\r\n');
    const log = (await readLog(env, code, '')).filter(ev => String(ev.at).startsWith(year)).reverse();
    const logCsv = [['Zeitpunkt (UTC)', 'Aktion', 'Rechnungsnummer', 'Bezug', 'Details', 'Person', 'E-Mail'].join(';'),
      ...log.map(ev => [ev.at, ev.event, ev.number || '', ev.cancels || '', [ev.from && ev.to ? `${ev.from} → ${ev.to}` : '', ev.reason || '', ev.format || '', ev.gross != null ? de(ev.gross) + ' €' : ''].filter(Boolean).join(' · '), ev.by && ev.by.name || '', ev.by && ev.by.email || ''].map(q).join(';'))].join('\r\n');
    const bom = '\ufeff';
    const readme = `Rechnungsarchiv ${code} – Jahr ${year}\r\nErstellt am ${new Date().toISOString()} mit AutoLeitwerk\r\n\r\n`
      + `Inhalt:\r\n- Rechnungen-PDF: alle Rechnungen und Stornorechnungen als Original-PDF\r\n- XRechnung: dieselben Belege als E-Rechnung (XRechnung 3.0, UBL)\r\n- Rechnungsdaten: maschinenlesbare Originaldaten je Beleg (JSON) mit Prüfwerten\r\n`
      + `- Rechnungsausgangsbuch_${year}.csv: alle Belege des Jahres, fortlaufend nummeriert\r\n- Protokoll_${year}.csv: Ausstellung, Storno, Zahlungsstatus, Abrufe mit Zeit und Person\r\n- Pruefwerte.sha256: SHA-256 jeder Datei (prüfbar z. B. mit \"sha256sum -c Pruefwerte.sha256\")\r\n\r\n`
      + `Die Belege wurden beim Ausstellen festgeschrieben und unverändert archiviert. Korrekturen erfolgen ausschließlich per Stornorechnung.\r\n`;
    files.push({ name: `Rechnungsausgangsbuch_${year}.csv`, data: bom + journal }, { name: `Protokoll_${year}.csv`, data: bom + logCsv });
    for (const f of files.slice(-2)) sums.push(`${await sha256(typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data)}  ${f.name}`);
    files.push({ name: 'Pruefwerte.sha256', data: sums.join('\n') + '\n' }, { name: 'LIESMICH.txt', data: readme });
    await logEvent(env, code, 'export', who, { year, count: index.length });
    const zip = makeZip(files);
    return new Response(zip, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="Rechnungsarchiv_${code}_${year}.zip"`, 'Cache-Control': 'no-store' } });
  }

  throw new HttpError(404, 'unknown_function');
}

export const INVOICE_FUNCTIONS = new Set(['invoiceExport', 'invoiceIssue', 'invoiceCancel', 'invoiceSetPayment', 'invoiceJournal', 'invoiceLog', 'invoiceDocument']);
