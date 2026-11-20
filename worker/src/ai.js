/**
 * KI für AutoLeitwerk über Cloudflare Workers AI (Binding "AI" in wrangler.toml).
 * Kein API-Key, keine Kosten pro Anfrage: kostenloses Tageskontingent (Workers Free).
 * Ist es aufgebraucht, antwortet der Server mit `ai_quota` – das Tablet nutzt dann das lokale Wissen.
 *
 *  - alexAsk:  Werkstatt-Fragen mit Wissensdatenbank (AlexKnowledge) + Werkstattdaten
 *  - tireScan: Reifen-/Felgenfotos auswerten (Größe, DOT, Profil, Schäden)
 */
import { recordAi } from './usage.js';
import KB_BUNDLED from '../../docs/alex_kb.json' with { type: 'json' };
import { findCodes, describeCode } from './dtc.js';

export const TEXT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// Nur für Vergleichstests in der Demo-Werkstatt (AL-DEMO) per model_test wählbar
const ALEX_TEST_MODELS = ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', '@cf/google/gemma-4-26b-a4b-it',
  '@cf/qwen/qwen3-30b-a3b-fp8', '@cf/zai-org/glm-4.7-flash', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/nvidia/nemotron-3-120b-a12b', '@cf/moonshotai/kimi-k2.5'];
export const VISION_MODELS = ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/google/gemma-3-12b-it'];
const ASK_PER_HOUR = 40;
const SCAN_PER_HOUR = 15;

export class AiError extends Error {
  constructor(status, code, message) { super(code); this.status = status; this.code = code; this.extra = { message }; this.isHttp = true; }
}

/* ---------- Hilfen ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
const plateKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '');
const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ist', 'sind', 'ein', 'eine', 'einen', 'mit', 'bei', 'für', 'fuer', 'wie', 'was', 'wann', 'wo', 'wir', 'ich', 'du', 'auf', 'aus', 'von', 'zum', 'zur', 'den', 'dem', 'des', 'noch', 'auch', 'kann', 'muss', 'soll', 'haben', 'hat', 'gibt', 'nicht', 'mal', 'bitte', 'heute', 'alex',
  'beim', 'vom', 'im', 'am', 'um', 'ins', 'ans', 'worauf', 'achten', 'welche', 'welcher', 'welches', 'wieviel', 'wie viel', 'viel', 'diesen', 'dieser', 'dieses', 'unser', 'unsere', 'meine', 'mein', 'sie', 'man', 'sagt', 'gemacht', 'machen', 'genau', 'immer', 'schon', 'jetzt', 'dann', 'wenn', 'aber', 'denn', 'weil', 'ungefähr', 'ungefaehr', 'ca', 'etwa', 'brauch', 'braucht', 'brauche', 'bekomme', 'ohne', 'nach', 'vor', 'über', 'ueber', 'unter', 'zwischen', 'finde', 'finden', 'zeige', 'zeigen', 'heißt', 'heisst', 'bedeutet', 'bedeutung']);
const tokens = s => norm(s).replace(/[^a-z0-9äöüß ]/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w));
const DE_DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const STATUS_DE = {
  fahrzeug_angenommen: 'Fahrzeug angenommen', diagnose_laeuft: 'Diagnose läuft', kostenvoranschlag: 'Kostenvoranschlag',
  freigabe_erforderlich: 'Freigabe erforderlich', ersatzteile_bestellt: 'Ersatzteile bestellt', warte_auf_ersatzteile: 'Wartet auf Ersatzteile',
  reparatur_laeuft: 'Reparatur läuft', qualitaetspruefung: 'Qualitätsprüfung', abholbereit: 'Abholbereit', abgeschlossen: 'Abgeschlossen',
};
function berlinDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(d);
}
const weekday = iso => DE_DAYS[new Date(iso + 'T12:00:00Z').getUTCDay()];
const deDate = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}.${m}.${y}`; };

const hits = new Map();
function limitPerHour(key, max) {
  const now = Date.now(); const e = hits.get(key) || { n: 0, t: now };
  if (now - e.t > 3600_000) { e.n = 0; e.t = now; }
  e.n++; hits.set(key, e);
  if (hits.size > 5000) hits.clear();
  if (e.n > max) throw new AiError(429, 'rate_limited', 'Zu viele KI-Anfragen in dieser Stunde – bitte gleich noch einmal versuchen.');
}

export async function runAi(env, model, input) {
  if (!env.AI) throw new AiError(503, 'not_available', 'KI ist auf dem Server noch nicht eingerichtet.');
  const kind = JSON.stringify((input && input.messages) || '').includes('image_url') ? 'vision' : 'text';
  try {
    const r = await env.AI.run(model, input);
    recordAi(model, r, kind);
    return r;
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('ai_error', model, msg.slice(0, 300));
    if (/neuron|quota|daily|allocation|4006|exceeded/i.test(msg)) {
      recordAi(model, null, kind, 'quota');
      throw new AiError(503, 'ai_quota', 'Das kostenlose KI-Tageskontingent ist aufgebraucht – ab 2 Uhr nachts wieder verfügbar.');
    }
    recordAi(model, null, kind, 'error');
    throw new AiError(502, 'ai_error', 'Die KI hat gerade nicht geantwortet. Bitte noch einmal versuchen.');
  }
}
function textOf(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response === 'object') return JSON.stringify(r.response);
  if (r.choices && r.choices[0]) return (r.choices[0].message && r.choices[0].message.content) || r.choices[0].text || '';
  return '';
}
export function parseJsonLoose(s) {
  if (s && typeof s === 'object') return s;
  const str = String(s || '').replace(/```(?:json)?/gi, '');
  const a = str.indexOf('{'); const b = str.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(str.slice(a, b + 1)); } catch { return null; }
}

/* ---------- Wissensdatenbank ---------- */
let kbCache = null;
async function loadKb(db, code) {
  if (!kbCache || Date.now() - kbCache.ts > 10 * 60_000) {
    let rows = [];
    try { rows = await db.list('AlexKnowledge', null, { limit: 1000 }); } catch (e) { console.log('kb_load', String(e && e.code || e)); }
    kbCache = { ts: Date.now(), rows: rows.length ? rows : KB_BUNDLED };
  }
  return kbCache.rows.filter(k => k.active !== false && (!k.workshop_code || k.workshop_code === code));
}
const fold = s => norm(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const ftokens = s => fold(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w));
// gleicher Wortstamm: identisch oder gleiche ersten 5 Buchstaben (bremse/bremsen/bremsbelaege)
const sameStem = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
// Suche mit Gewichtung nach Seltenheit: Wörter, die in vielen Einträgen vorkommen (prüfen, motor, wechseln),
// zählen wenig – seltene Fachbegriffe (bremsbelag, ladedruck, p0299) viel. Treffer unter der Hälfte des besten fallen weg.
const idfCache = new WeakMap();
function kbIndex(kb) {
  let ix = idfCache.get(kb);
  if (ix) return ix;
  const docs = kb.map(k => {
    const kws = String(k.keywords || '').split(',').map(x => fold(x)).filter(w => w.length > 2);
    const pre = fold(String(k.title).split(/ [–-] /)[0]);
    // Modellcodes im Titel (E30, F31, N47, W205 …) – sonst nur die Marke
    const models = [...new Set(pre.match(/\b([ef]\d{2}|g\d{2}|[nmb]\d{2}[a-z]{0,2}|w\d{3}|b\d|mk\d|8[a-z]|[0-9][a-z]\d?)\b/g) || [])];
    const spec = models.length ? models : k.brand ? [fold(k.brand)] : [];
    return { k, kws, spec, head: [...new Set([...kws.flatMap(x => x.split(' ')), ...ftokens(k.title)])].filter(w => w.length > 2), body: ftokens(k.content), all: fold(k.title + ' ' + k.keywords + ' ' + k.content) };
  });
  const df = new Map();
  docs.forEach(d => new Set([...d.head, ...d.body].map(w => w.slice(0, 7))).forEach(st => df.set(st, (df.get(st) || 0) + 1)));
  const N = Math.max(2, docs.length);
  ix = { docs, idf: w => Math.log((N + 1) / ((df.get(w.slice(0, 7)) || 0) + 1)) / Math.log(N + 1) };
  idfCache.set(kb, ix);
  return ix;
}
// Wortstamm für die Suche: gemeinsamer Anfang von mind. 5 Zeichen bzw. Länge des kürzeren Worts minus 2
// (ruckelt/ruckeln, bremse/bremsbelaege – aber nicht ueberfaellig/uebersicht oder steuerkette/steuergeraet)
const kbStem = (a, b) => { if (a === b) return true; const n = Math.max(5, Math.min(a.length, b.length) - 2); return a.length >= 5 && b.length >= 5 && a.slice(0, n) === b.slice(0, n); };
// Allerweltswörter: zählen kaum und machen allein keinen Treffer
const KB_GENERIC = new Set(['wechseln', 'wechsel', 'tauschen', 'fehler', 'motor', 'pruefen', 'pruefung', 'defekt', 'problem', 'kaputt', 'auto', 'fahrzeug', 'wagen', 'geht', 'funktioniert', 'richtig', 'zuerst', 'vorne', 'hinten', 'links', 'rechts', 'intervall', 'kosten', 'dauer', 'dauert', 'lange']);
export function searchKb(kb, question, vehicle, debug) {
  if (!kb || !kb.length) return [];
  const { docs, idf } = kbIndex(kb);
  const qt = [...new Set(ftokens(question + ' ' + (vehicle || '')))];
  const qf = fold(question + ' ' + (vehicle || ''));
  const codes = (qf.match(/\b[pcbu][0-9][0-9a-f]{3}\b/g) || []);
  const has = (list, w) => list.some(x => kbStem(x, w));
  const scored = docs.map(d => {
    // Modell-/Motor-spezifische Einträge („BMW E30 – …“, Marke gesetzt) nur, wenn Frage oder Fahrzeug dazu passen
    if (d.spec.length && !d.spec.some(t => qf.includes(t))) return { k: d.k, score: 0, strong: false, why: [] };
    let score = 0; let strong = false; const why = [];
    qt.forEach(w => {
      if (KB_GENERIC.has(w)) { if (has(d.head, w)) score += 0.5; return; }
      const wi = idf(w);
      if (has(d.head, w)) { score += 1 + 3 * wi; if (wi >= 0.3) strong = true; if (debug) why.push(w + ':' + wi.toFixed(2)); }
      else if (w.length > 4 && has(d.body, w)) score += 0.6 * wi;
    });
    // mehrteilige Schlagwörter („ladedruck zu niedrig“) als Ganzes
    d.kws.forEach(x => { if (x.includes(' ') && qf.includes(x)) { score += 3; strong = true; } });
    codes.forEach(c => { if (d.all.includes(c)) { score += 8; strong = true; } });
    if (d.k.brand && qf.includes(fold(d.k.brand))) score += 1.5;
    return { k: d.k, score, strong, why };
  }).filter(x => x.strong && x.score >= 2.2).sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  if (debug) return scored.slice(0, 6).map(x => [x.k.title, x.score.toFixed(1), x.why.join(' ')]);
  return scored.filter(x => x.score >= best * 0.5).slice(0, 4).map(x => x.k);
}

/* ---------- Werkstattdaten → Fakten + Karten ---------- */
const OPEN = o => !['abgeschlossen'].includes(o.status);
function orderLine(o) {
  return `#${o.order_number || '?'} ${[o.vehicle_brand, o.vehicle_model].filter(Boolean).join(' ')} ${o.license_plate || ''}, Kunde ${o.customer_name || '?'}, ${STATUS_DE[o.status] || o.status}`
    + (o.priority === 'eilig' ? ', EILIG' : '') + (o.assigned_mechanic ? `, Mechaniker ${o.assigned_mechanic}` : '')
    + (o.planned_completion ? `, fertig geplant ${deDate(o.planned_completion)}` : '') + (o.description ? ` – ${String(o.description).slice(0, 80)}` : '');
}
export function capacityDays(appointments, employees, days = 7) {
  const mech = Math.max(1, employees.filter(e => e.role !== 'serviceberater').length);
  const out = [];
  for (let i = 0; out.length < days && i < 14; i++) {
    const iso = berlinDate(i);
    if (weekday(iso) === 'Sonntag') continue;
    const mins = appointments.filter(a => a.appointment_date === iso && a.status !== 'storniert')
      .reduce((s, a) => s + (Number(a.estimated_duration) || 30), 0);
    const cap = mech * (weekday(iso) === 'Samstag' ? 240 : 480);
    const pct = Math.round(mins / cap * 100);
    out.push({ type: 'kapazitaet', datum: iso, pct, minutes: mins, count: appointments.filter(a => a.appointment_date === iso && a.status !== 'storniert').length, status: pct >= 90 ? 'rot' : pct >= 70 ? 'gelb' : 'gruen' });
  }
  return out;
}
function findCustomers(question, data) {
  const qt = tokens(question); const qp = plateKey(question);
  const people = new Map();
  const add = (name, plate) => { if (!name) return; const k = norm(name); if (!people.has(k)) people.set(k, { name, plates: new Set() }); if (plate) people.get(k).plates.add(plate); };
  data.orders.forEach(o => add(o.customer_name, o.license_plate));
  data.tire_sets.forEach(t => add(t.customer_name, t.license_plate));
  data.appointments.forEach(a => add(a.customer_name, a.license_plate));
  const found = [];
  people.forEach(p => {
    const parts = tokens(p.name).filter(w => w.length >= 3);
    const nameHit = parts.length && parts.some(w => qt.includes(w));
    const plateHit = [...p.plates].some(pl => { const k = plateKey(pl); return k.length >= 4 && qp.includes(k); });
    if (nameHit || plateHit) found.push(p);
  });
  return found.slice(0, 2).map(p => {
    const k = norm(p.name);
    const os = data.orders.filter(o => norm(o.customer_name) === k);
    const open = os.filter(OPEN);
    const tires = data.tire_sets.filter(t => norm(t.customer_name) === k && (t.status || 'eingelagert') !== 'ausgelagert');
    const vehicles = [...new Set(os.map(o => [o.vehicle_brand, o.vehicle_model, o.license_plate].filter(Boolean).join(' ')).filter(Boolean))];
    const last = os.map(o => o.created_date).filter(Boolean).sort().pop();
    return { type: 'kunde', customer: { name: p.name, license_plate: [...p.plates][0] || '', vehicles, last_visit: last ? last.slice(0, 10) : null, open_orders: open.length, open_order_ids: open.map(o => o.id), tires: tires.map(t => ({ season: t.season, brand: t.brand, size: t.size, tread_depth: t.tread_depth, storage_location: t.storage_location })) } };
  });
}
function findParts(question, inventory) {
  const qt = tokens(question).filter(w => w.length > 3);
  if (!qt.length) return [];
  const stem = w => w.replace(/(en|er|e|n|s)$/, '');
  return inventory.filter(i => {
    const hay = norm([i.name, i.part_number, i.category].join(' '));
    return qt.some(w => hay.includes(stem(w)));
  }).slice(0, 4).map(i => ({
    type: 'teil', title: i.name, subtitle: i.part_number || '',
    lines: [`Bestand: ${i.stock_quantity ?? 0} ${i.unit || 'Stück'}${i.min_stock ? ` (Mindestbestand ${i.min_stock})` : ''}`, i.location ? `Lagerort: ${i.location}` : '', i.supplier_name ? `Lieferant: ${i.supplier_name}` : ''].filter(Boolean),
    level: (Number(i.stock_quantity) || 0) <= 0 ? 'rot' : (Number(i.stock_quantity) || 0) <= (Number(i.min_stock) || 0) ? 'gelb' : 'gruen',
  }));
}
function recommendations(data) {
  const today = berlinDate(0); const items = [];
  data.orders.filter(OPEN).forEach(o => {
    const ref = `#${o.order_number || '?'} ${o.license_plate || ''}`.trim();
    if (o.status === 'abholbereit') return;
    if (o.planned_completion && o.planned_completion.slice(0, 10) < today) items.push({ title: `${ref} ist überfällig`, detail: `Fertig geplant ${deDate(o.planned_completion)} – Kunde ${o.customer_name || ''} informieren`, priority: 3, action: { kind: 'open_order', order_id: o.id } });
    else if (o.priority === 'eilig') items.push({ title: `${ref} ist eilig`, detail: `${STATUS_DE[o.status] || o.status}${o.assigned_mechanic ? ' · ' + o.assigned_mechanic : ''}`, priority: 3, action: { kind: 'open_order', order_id: o.id } });
    else if (o.status === 'freigabe_erforderlich') items.push({ title: `${ref} wartet auf Kundenfreigabe`, detail: `Kunde ${o.customer_name || ''} nachfassen`, priority: 2, action: { kind: 'open_order', order_id: o.id } });
    else if (o.planned_completion && o.planned_completion.slice(0, 10) === today) items.push({ title: `${ref} soll heute fertig werden`, detail: STATUS_DE[o.status] || o.status, priority: 2, action: { kind: 'open_order', order_id: o.id } });
  });
  data.appointments.filter(a => a.appointment_date === today && a.status !== 'storniert')
    .sort((a, b) => String(a.time_slot).localeCompare(String(b.time_slot)))
    .forEach(a => items.push({ title: `${a.time_slot || ''} Uhr: ${a.service_name || a.appointment_type || 'Termin'}`, detail: [a.customer_name, a.vehicle_brand, a.license_plate].filter(Boolean).join(' · '), priority: 1 }));
  return items.sort((a, b) => b.priority - a.priority).slice(0, 8);
}

/* ---------- ALEX ---------- */
export const ALEX_MODEL = '@cf/openai/gpt-oss-120b';
const ALEX_TIMEOUT_MS = 30_000;

// Echte Seiten im Dashboard – ALEX nennt nur diese (vorher wurden Menüs erfunden)
const NAVIGATION = `Aufträge › Alle Aufträge / Neuer Auftrag / Teilebestellung / Freigaben; Werkstatt › Leitstelle / Hebebühnen / Tablet;
Planung › Termine / Kalender / Einsatzplanung / Kapazitätsplanung; Telefon; Kunden & Fahrzeuge › Kunden / Fahrzeuge / HU- & Service-Erinnerung;
Lager › Teile Lager (Knopf „Inventur“: Zählliste, zählen, Differenzen buchen, Protokoll) / Reifenlager; Team › Mitarbeiter / Arbeitszeiten (Anwesenheit aus der Stempeluhr am Tablet „Kommen/Gehen“, Export fürs Lohnbüro als CSV und Stundennachweise); Finanzen › Buchhaltung (Bereiche: Übersicht, Belege = Ausgangsrechnungen, Mahnwesen, Eingang = Eingangsrechnungen/Belege, Abos, Auslagen, Umsätze = Kontoauszüge importieren, Überweisungen, Konten, Kassenbuch, Rechnungskunden, Lieferanten, Artikel, Offene Posten, Kontenübersicht, Buchungen, Auswertung, DATEV & Abschluss) / Rechnungen / Dienstleistungen & Preise (auch Arbeitspositionen nach Arbeitswerten mit Stundensatz, Fahrzeugklasse im Auftrag oben „AW-Klasse“; Browser-Erweiterung für den Teile-Import unter Einstellungen);
Berichte › Statistiken / Kennzahlen / Mitarbeiter-Berichte / Protokolle; Benachrichtigungen; Einstellungen; Hilfe & Support › Support / Live-Chat`;

const SYSTEM = `Du bist ALEX, der KI-Assistent im Werkstatt-Tablet „AutoLeitwerk“ einer KFZ-Werkstatt.
Regeln:
- Antworte immer auf Deutsch in der Sie-Form, kurz und praxisnah für Mechaniker und Serviceberater (höchstens ca. 150 Wörter). Fachbegriffe auf Deutsch (Ladedruck, nicht Boost; Abgaskrümmer nur, wenn gemeint).
- Arbeitsschritte als nummerierte Liste, wichtige Werte **fett**. Keine Einleitungsfloskeln, keine Wiederholung der Frage.
- Nutze zuerst FEHLERCODES, WERKSTATTDATEN und WISSENSEINTRÄGE. Wenn du einen Wissenseintrag verwendest, schreibe dahinter [Eintrag N]. Wissenseinträge, die nicht zur Frage passen, ignorierst du.
- Fehlercodes: Die Bedeutung steht unter FEHLERCODES – übernimm sie genau so. Steht ein Code dort als herstellerspezifisch oder nicht hinterlegt, rate die Bedeutung NICHT, sondern sage das und empfehle Diagnosetester/Herstellerdaten.
- Allgemeines Werkstattwissen (Diagnose-Vorgehen, typische Ursachen, Prüfreihenfolge) darfst du verwenden. Erfinde aber niemals Drehmomente, Füllmengen, Einstell- und Prüfwerte, Teilenummern, Preise, Termine oder Bestände – steht so ein Wert nicht in den Daten, sage „laut Herstellerdaten“ und nenne keine Zahl. Arbeitszeiten nur als grober Erfahrungswert und ausdrücklich so gekennzeichnet (Herstellerarbeitswerte prüfen).
- Sicherheit: Bei Bremsen, Lenkung, Airbag, Hochvolt, Fahrwerk und Rädern auf die Herstellervorgaben hinweisen. Steht unten ein Abschnitt SICHERHEIT, nenne diesen Hinweis zuerst – sonst keine Warnungen erfinden, die nichts mit der Frage zu tun haben.
- Zahlen zu Aufträgen, Terminen, Lager, Umsatz und Rechnungen nur aus den WERKSTATTDATEN. Fehlen sie dort, sage das – schätze nie.
- Seiten im Dashboard nur so nennen, wie sie in der NAVIGATION stehen. Andere Menüs gibt es nicht.
- Du kannst selbst nichts anlegen oder ändern. Nur wenn ausdrücklich etwas angelegt werden soll: sagen, dass das im Dashboard über ALEX oder „Neuer Auftrag“ geht.
- Aufzählungen von Aufträgen kurz halten (höchstens 5, die wichtigsten zuerst) – die Details zeigt das Tablet als Karten.
- Beantworte genau die gestellte Frage (fragt jemand nach der Dauer, nenne die Dauer – keine Arbeitsanleitung).
- Werte aus Wissenseinträgen nur für genau das Bauteil verwenden, für das sie dort stehen (z. B. Radschrauben-Drehmoment nie für Bremssattelschrauben).
- Wissenseinträge zu einem bestimmten Modell/Motor (z. B. „BMW E30 – …“) nur verwenden, wenn es um genau dieses Fahrzeug geht.
- Wenn die Frage unklar ist (z. B. welches Fahrzeug), stelle genau eine kurze Rückfrage.

NAVIGATION: ${NAVIGATION}`;

// Dashboard: Text wird ohne Markdown angezeigt; Entwürfe legt ALEX dort selbst an (nach Bestätigung)
const SYSTEM_DASHBOARD = SYSTEM
  .replace('im Werkstatt-Tablet „AutoLeitwerk“', 'im Dashboard von „AutoLeitwerk“')
  .replace('Arbeitsschritte als nummerierte Liste, wichtige Werte **fett**.', 'Arbeitsschritte als nummerierte Liste (1., 2., …). Kein Markdown, keine Sternchen, keine Tabellen.')
  .replace('- Du kannst selbst nichts anlegen oder ändern. Nur wenn ausdrücklich etwas angelegt werden soll: sagen, dass das im Dashboard über ALEX oder „Neuer Auftrag“ geht.',
    '- Aufträge, Termine und Teilebestellungen legst du nur als Entwurf an, wenn der Nutzer es ausdrücklich verlangt (z. B. „Neuer Auftrag für AB-CD 123, Ölwechsel“). Sonst nur antworten.')
  .replace('die Details zeigt das Tablet als Karten', 'die Details zeigt das Dashboard als Karten');

// Hinweise, die unabhängig von der KI immer stimmen müssen
function safetyFacts(qn) {
  const out = [];
  if (/(motor)?kontroll(leuchte|lampe)|mkl|motorleuchte|check.?engine/.test(qn) && /blink/.test(qn))
    out.push('Blinkende Motorkontrollleuchte = starke Zündaussetzer, unverbrannter Kraftstoff gelangt in den Katalysator (Überhitzung/Schaden). Fahrzeug nicht unter Last weiterfahren, Fehlerspeicher auslesen (P0300–P0312).');
  if (/öldruck|oeldruck|öllampe|oellampe|ölkontroll|oelkontroll/.test(qn))
    out.push('Rote Öldruckleuchte während der Fahrt: Motor sofort abstellen, nicht weiterfahren – erst Ölstand und Öldruck (mechanisch messen) prüfen.');
  if (/temperatur.*(rot|hoch|überhitz|ueberhitz)|überhitz|ueberhitz|kocht/.test(qn))
    out.push('Überhitzung: Kühlsystem nicht im heißen Zustand öffnen (Verbrühungsgefahr); Motor nicht weiter belasten (Zylinderkopfdichtung).');
  if (/hochvolt|hv-|hybrid|elektroauto|e-auto|\bev\b/.test(qn))
    out.push('Hochvolt: Arbeiten nur durch Personal mit HV-Qualifikation nach Herstellervorgabe (Freischalten, gegen Wiedereinschalten sichern, Spannungsfreiheit feststellen).');
  if (/airbag|gurtstraffer/.test(qn))
    out.push('Airbag/Gurtstraffer: vor Arbeiten Batterie abklemmen und Wartezeit nach Herstellerangabe einhalten; Bauteile nie mit Messgerät durchmessen.');
  return out;
}

// Rechnungen/Umsatz aus den Aufträgen (nur Dashboard – im Tablet sehen Mechaniker keine Zahlen)
const eur = n => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
export function financeFacts(orders, receipts, today) {
  const month = today.slice(0, 7);
  const prev = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const inv = orders.filter(o => o.invoice_number && o.invoice_date && Number(o.total_amount) > 0);
  const sum = list => list.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const inMonth = (m) => inv.filter(o => String(o.invoice_date).slice(0, 7) === m);
  const year = inv.filter(o => String(o.invoice_date).slice(0, 4) === today.slice(0, 4));
  const open = inv.filter(o => (o.payment_status || 'offen') !== 'bezahlt');
  const overdue = open.filter(o => o.payment_due_date && String(o.payment_due_date).slice(0, 10) < today);
  const lines = [
    `Rechnungen diesen Monat (${month}): ${inMonth(month).length} Stück, ${eur(sum(inMonth(month)))} brutto`,
    `Rechnungen Vormonat (${prev}): ${inMonth(prev).length} Stück, ${eur(sum(inMonth(prev)))} brutto`,
    `Rechnungen ${today.slice(0, 4)} bisher: ${year.length} Stück, ${eur(sum(year))} brutto`,
    `Offene (unbezahlte) Rechnungen: ${open.length} Stück, ${eur(sum(open))}` + (overdue.length ? `; davon überfällig: ${overdue.length} (${eur(sum(overdue))}) – ${overdue.slice(0, 5).map(o => `${o.invoice_number} ${o.customer_name || ''} ${eur(o.total_amount)} fällig ${deDate(o.payment_due_date)}`).join('; ')}` : '; keine überfällig'),
  ];
  if (receipts) {
    const r = receipts.filter(x => String(x.receipt_date || '').slice(0, 7) === month && x.kind !== 'gutschrift');
    const ro = receipts.filter(x => (x.payment_status || 'offen') !== 'bezahlt');
    lines.push(`Ausgaben/Belege diesen Monat: ${r.length} Stück, ${eur(r.reduce((s, x) => s + Number(x.gross || 0), 0))} brutto; unbezahlte Belege: ${ro.length} (${eur(ro.reduce((s, x) => s + Number(x.gross || 0), 0))})`);
  }
  lines.push('Hinweis: Umsatz = Summe der ausgestellten Rechnungen (brutto) laut Aufträgen; stornierte Rechnungen sind nicht enthalten. Details: Finanzen › Buchhaltung.');
  return 'FINANZEN:\n' + lines.join('\n');
}

function todayFacts(data, today) {
  const open = data.orders.filter(OPEN);
  const late = o => o.status !== 'abholbereit' && o.planned_completion && String(o.planned_completion).slice(0, 10) < today;
  const waiting = ['freigabe_erforderlich', 'ersatzteile_bestellt', 'warte_auf_ersatzteile', 'kostenvoranschlag'];
  const grp = (title, list) => `${title} (${list.length}):\n` + (list.slice(0, 8).map(o => '- ' + orderLine(o) + (late(o) ? ' – ÜBERFÄLLIG' : '')).join('\n') || '- keine');
  const appts = data.appointments.filter(a => a.appointment_date === today && a.status !== 'storniert').sort((a, b) => String(a.time_slot).localeCompare(String(b.time_slot)));
  return [
    grp('ÜBERFÄLLIG (geplantes Fertigdatum vorbei)', open.filter(late)),
    grp('IN ARBEIT', open.filter(o => !waiting.includes(o.status) && o.status !== 'abholbereit' && !late(o))),
    grp('WARTET (Freigabe, Teile, Kostenvoranschlag)', open.filter(o => waiting.includes(o.status) && !late(o))),
    grp('ABHOLBEREIT (Arbeit fertig – Kunde holt ab, keine Werkstattaufgabe)', open.filter(o => o.status === 'abholbereit')),
    `TERMINE HEUTE (${appts.length}):\n` + (appts.map(a => `- ${a.time_slot || ''} Uhr ${a.service_name || a.appointment_type || 'Termin'} – ${[a.customer_name, a.vehicle_brand, a.license_plate].filter(Boolean).join(', ')}`).join('\n') || '- keine'),
  ].join('\n\n');
}

function withTimeout(promise, ms) {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new AiError(504, 'ai_error', 'Die KI hat zu lange gebraucht.')), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export async function alexAsk(db, sess, body, env, data) {
  limitPerHour('ask:' + sess.employee_id, ASK_PER_HOUR);
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 1500) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const last = msgs.filter(m => m.role === 'user').pop();
  if (!last) throw new AiError(400, 'params', 'Keine Frage übermittelt.');
  const q = last.content;
  const qn = norm(q);
  // Rückfrage („Und wenn …?“): vorherige Nutzerfrage für Suche und Fehlercodes mitnehmen
  const prevUser = msgs.filter(m => m.role === 'user').slice(-2, -1).map(m => m.content).join(' ');
  const followUp = prevUser && (q.length < 80 || /^(und|aber|was ist|wenn|dann|ok|gut|ja|nein)\b/i.test(q.trim()));
  const searchText = followUp ? prevUser + ' ' + q : q;

  const order = body.order_id ? data.orders.find(o => o.id === body.order_id) : null;
  const vehicle = order ? [order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ') : '';
  const kb = searchKb(await loadKb(db, sess.workshop_code), searchText, vehicle);

  const cards = []; const facts = [];
  const today = berlinDate(0);
  facts.push(`Heute ist ${weekday(today)}, ${deDate(today)}.`);
  if (order) {
    const tasks = data.tasks.filter(t => t.order_id === order.id);
    facts.push('AKTUELLES FAHRZEUG (Auftrag):\n' + orderLine(order)
      + `\nFahrzeugdaten: ${[order.vin && 'FIN ' + order.vin, order.hsn && 'HSN ' + order.hsn, order.tsn && 'TSN ' + order.tsn, order.first_registration && 'EZ ' + deDate(order.first_registration), order.fuel_type, order.power_kw && order.power_kw + ' kW', order.displacement_ccm && order.displacement_ccm + ' ccm', order.mileage && order.mileage + ' km'].filter(Boolean).join(', ') || 'keine'}`
      + (tasks.length ? `\nAufgaben: ${tasks.map(t => `${t.title} (${t.status})`).join('; ')}` : ''));
  }
  const codes = findCodes(searchText + ' ' + (order ? order.description || '' : ''));
  const codeFacts = codes.map(describeCode);
  const safety = safetyFacts(norm(searchText));
  const wantsToday = /heute|steht.*an|was (soll|muss|ist) .*(tun|machen|an)|zu tun|priorit|empfehl|überfällig|ueberfaellig|dringend|eilig|tagesplan|offene auftr|welche auftr/.test(qn);
  const wantsCap = /voll|kapazit|auslast|frei|platz|termin|woche|morgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag/.test(qn);
  const wantsParts = /lager|bestand|vorrätig|vorraetig|teil|haben wir|da\?|nachbestell/.test(qn);
  const wantsMoney = /umsatz|rechnung|einnahm|verdien|ausgab|kosten wir|gewinn|bezahlt|zahlung|offene posten|mahnung|forderung|beleg|geld|€|euro/.test(qn);
  if (wantsToday) {
    const rec = recommendations(data);
    if (rec.length) cards.push({ type: 'empfehlungen', items: rec });
    facts.push(todayFacts(data, today));
  }
  if (wantsCap) {
    const cap = capacityDays(data.appointments, data.employees);
    cards.push(...cap);
    facts.push('AUSLASTUNG nächste Tage (aus Terminen):\n' + cap.map(c => `${weekday(c.datum)} ${deDate(c.datum)}: ${c.pct} % (${c.count} Termine, ${c.minutes} Min.)`).join('\n'));
  }
  const customers = findCustomers(q, data);
  customers.forEach(c => {
    cards.push(c); const k = c.customer;
    facts.push(`KUNDE ${k.name}: Fahrzeuge ${k.vehicles.join('; ') || '–'}; offene Aufträge ${k.open_orders}; eingelagerte Reifen: ${k.tires.map(t => [t.season, t.brand, t.size, t.tread_depth != null && t.tread_depth + ' mm', t.storage_location && 'Platz ' + t.storage_location].filter(Boolean).join(' ')).join(' | ') || 'keine'}`);
  });
  if (wantsParts) {
    const parts = findParts(q, data.inventory);
    cards.push(...parts);
    facts.push('LAGER (Treffer):\n' + (parts.map(p => `${p.title} ${p.subtitle}: ${p.lines.join(', ')}`).join('\n') || (data.inventory.length ? 'kein passender Artikel im Lager gefunden' : 'Lagerbestand ist im System nicht gepflegt')));
  }
  if (wantsMoney) {
    if (body.channel === 'dashboard') {
      let receipts = null;
      try { receipts = data.loadReceipts ? await data.loadReceipts() : null; } catch { receipts = null; }
      facts.push(financeFacts(data.orders, receipts, today));
    } else facts.push('FINANZEN: Umsatz- und Rechnungszahlen gibt es am Tablet nicht – nur im Dashboard unter Finanzen › Buchhaltung.');
  }

  const context = (codeFacts.length ? 'FEHLERCODES (verbindliche Bedeutung):\n' + codeFacts.map(c => `${c.code}: ${c.text}${c.hint ? '\nTypische Prüfschritte: ' + c.hint : ''}`).join('\n') + '\n\n' : '')
    + (safety.length ? 'SICHERHEIT (immer zuerst nennen):\n' + safety.map(x => '- ' + x).join('\n') + '\n\n' : '')
    + `WERKSTATTDATEN:\n${facts.join('\n\n')}\n\nWISSENSEINTRÄGE:\n`
    + (kb.length ? kb.map((k, i) => `[Eintrag ${i + 1}] ${k.title}${k.brand ? ' (' + k.brand + ')' : ''}\n${String(k.content).slice(0, 1400)}`).join('\n\n') : 'keine passenden Einträge');
  const system = (body.channel === 'dashboard' ? SYSTEM_DASHBOARD : SYSTEM) + '\n\n' + context;
  const test = sess.workshop_code === 'AL-DEMO' && ALEX_TEST_MODELS.includes(body.model_test) ? body.model_test : null;
  const effort = test && ['low', 'medium', 'high'].includes(body.effort_test) ? body.effort_test : null;
  const call = (model) => withTimeout(runAi(env, model, { messages: [{ role: 'system', content: system }, ...msgs], max_tokens: model === TEXT_MODEL ? 700 : 2500, temperature: 0.3,
    ...(effort ? { reasoning: { effort } } : {}) }), ALEX_TIMEOUT_MS);
  let model = test || ALEX_MODEL; let r;
  try { r = await call(model); }
  catch (e) {
    // Hauptmodell gestört (nicht Kontingent): einmal mit dem bisherigen Modell versuchen
    if (test || !e || e.code !== 'ai_error' || model === TEXT_MODEL) throw e;
    console.log('alex_fallback', String(e.extra && e.extra.message || e.code));
    model = TEXT_MODEL; r = await call(model);
  }
  let answer = textOf(r).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!answer && model !== TEXT_MODEL && !test) { model = TEXT_MODEL; r = await call(model); answer = textOf(r).trim(); }
  if (!answer) throw new AiError(502, 'ai_error', 'Die KI hat keine Antwort geliefert.');
  return {
    ok: true, answer, cards,
    sources: kb.map(k => ({ title: k.title })),
    codes: codeFacts.map(c => ({ code: c.code, text: c.text, known: c.known })),
    used_general_knowledge: !kb.length && !cards.length && !order && !codeFacts.length,
    model: 'workers-ai', ...(test ? { test_model: model, usage: r && r.usage } : {}),
  };
}

/* ---------- Reifenscan ---------- */
const TIRE_PROMPT = `Du analysierst Fotos eines Autoreifens (Flanke mit Beschriftung, Lauffläche, Felge) für eine KFZ-Werkstatt.
Lies nur ab, was wirklich erkennbar ist. Unsicheres mit niedriger confidence (0–1) angeben, nicht Erkennbares als null.
Antworte NUR mit JSON in genau diesem Format:
{"brand":{"value":"","confidence":0},"model":{"value":"","confidence":0},"size":{"value":"z.B. 205/55 R16","confidence":0},
"load_index":{"value":"z.B. 91","confidence":0},"speed_index":{"value":"z.B. V","confidence":0},
"season":{"value":"sommer|winter|ganzjahr","confidence":0},"dot_code":{"value":"letzte 4 Ziffern, z.B. 2319","confidence":0},
"tread_depth_mm":{"value":0,"confidence":0},"overall_condition":{"value":"gut|mittel|abgefahren|beschädigt","confidence":0},
"tire_damages":[{"type":"","description":"","severity":"niedrig|mittel|hoch"}],
"rim_damages":[{"type":"","description":"","severity":"niedrig|mittel|hoch"}]}
Hinweise: Winterreifen haben das Alpine-Symbol (Berg mit Schneeflocke) oder M+S. Die DOT-Endung WWJJ steht für Produktionswoche und -jahr.
Profiltiefe nur schätzen, wenn die Lauffläche gut sichtbar ist (TWI-Indikator), sonst confidence niedrig.`;

function field(v, conf, max = 60) {
  if (v && typeof v === 'object' && 'value' in v) { conf = v.confidence; v = v.value; }
  if (v === '' || v === undefined) v = null;
  if (typeof v === 'string') v = v.trim().slice(0, max) || null;
  const c = Math.max(0, Math.min(1, Number(conf)));
  return { value: v, confidence: Number.isFinite(c) ? c : 0.5 };
}
export function normalizeTire(raw) {
  const r = raw || {};
  const out = {};
  ['brand', 'model', 'size', 'load_index', 'speed_index', 'overall_condition'].forEach(k => { out[k] = field(r[k]); });
  const s = field(r.season); const sv = norm(s.value);
  s.value = /winter|m\+s|alpin/.test(sv) ? 'winter' : /ganz|all|4 ?season/.test(sv) ? 'ganzjahr' : /sommer|summer/.test(sv) ? 'sommer' : null;
  out.season = s;
  const d = field(r.dot_code); const digits = String(d.value || '').replace(/\D/g, '');
  const wwyy = digits.length >= 4 ? digits.slice(-4) : null;
  out.dot_code = { value: wwyy, confidence: wwyy ? d.confidence : 0 };
  let week = null, year = null;
  if (wwyy) { week = Number(wwyy.slice(0, 2)); year = 2000 + Number(wwyy.slice(2)); if (week < 1 || week > 53 || year > new Date().getFullYear()) { week = null; year = null; } }
  out.production_week = { value: week, confidence: week ? d.confidence : 0 };
  out.production_year = { value: year, confidence: year ? d.confidence : 0 };
  const age = year ? Math.max(0, Math.round(((Date.now() - Date.UTC(year, 0, 1 + (week - 1) * 7)) / (365.25 * 86400_000)) * 10) / 10) : null;
  out.tire_age_years = { value: age, confidence: year ? d.confidence : 0 };
  const t = field(r.tread_depth_mm); const tv = Number(String(t.value ?? '').replace(',', '.'));
  out.tread_depth_mm = { value: Number.isFinite(tv) && tv > 0 && tv < 15 ? Math.round(tv * 10) / 10 : null, confidence: t.confidence };
  const dmg = list => (Array.isArray(list) ? list : []).filter(x => x && (x.type || x.description)).slice(0, 6)
    .map(x => ({ type: String(x.type || '').slice(0, 60), description: String(x.description || '').slice(0, 200), severity: String(x.severity || '').slice(0, 20) }));
  out.tire_damages = dmg(r.tire_damages);
  out.rim_damages = dmg(r.rim_damages);
  return out;
}

async function visionJson(env, prompt, images, maxTokens) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] }];
  let lastErr;
  for (const model of VISION_MODELS) {
    try {
      const r = await runAi(env, model, { messages, max_tokens: maxTokens || 900, temperature: 0.1 });
      const parsed = parseJsonLoose(textOf(r));
      if (parsed) return parsed;
      lastErr = new AiError(502, 'ai_error', 'Die KI-Antwort war unlesbar. Bitte noch einmal versuchen.');
    } catch (e) {
      if (e.code === 'ai_quota' || e.code === 'not_available') throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function tireScan(sess, body, env, checkImage) {
  limitPerHour('scan:' + sess.employee_id, SCAN_PER_HOUR);
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 3);
  if (!images.length) throw new AiError(400, 'params', 'Kein Foto übermittelt.');
  images.forEach(checkImage);
  const parsed = await visionJson(env, TIRE_PROMPT, images, 900);
  return { ok: true, result: normalizeTire(parsed), image_urls: [], model: 'workers-ai' };
}

/* ---------- Fahrzeugschein (Zulassungsbescheinigung Teil I) ---------- */
// Aufbau nach Anlage 6 FZV: Buchstabenfelder EU-einheitlich (A Kennzeichen, B Erstzulassung, C.1.x Halter, D.1–D.3 Marke/Typ/Handelsname,
// E FIN, I Datum dieser Zulassung, J Fahrzeugklasse, P.1 Hubraum, P.2/P.4 kW/Drehzahl, P.3 Kraftstoff, R Farbe, V.9 Schadstoffklasse),
// Ziffernfelder in Klammern national ((2.1) HSN, (2.2) TSN + Varianten-Code mit Prüfziffer, (3) Prüfziffer zur FIN, (14.1) Emissionsschlüssel,
// (15.1)/(15.2) Bereifung Achse 1/2). Die nächste HU steht vorne im Feld „Nächste HU“ (Monat/Jahr) bzw. als Stempel.
const REG_FIELDS = ['kennzeichen', 'erstzulassung', 'datum_zulassung', 'halter_name', 'halter_adresse', 'marke', 'typ_variante', 'modell_handelsbezeichnung', 'fin', 'pruefziffer', 'hsn', 'tsn', 'kraftstoff', 'leistung_kw', 'hubraum_ccm', 'farbe', 'naechste_hu', 'fahrzeugklasse', 'schadstoffklasse', 'emissionsschluessel', 'reifen_achse1', 'reifen_achse2'];
const REG_PROMPT = `Du liest ein Foto einer deutschen Zulassungsbescheinigung Teil I (Fahrzeugschein, Format seit 2005).
Jedes Feld ist mit einem kleinen Code beschriftet: Buchstaben (A, B, C.1.1 …) sind EU-einheitlich, Ziffern ((2.1), (3), (15.1) …) sind deutsche Felder.
Aufbau des aufgeklappten Scheins:
- Links (Halterseite): A Kennzeichen (groß), C.1.1 Name, C.1.2 Vorname, C.1.3 Anschrift, unten "Nächste HU Monat/Jahr" (z. B. 11.2025) und I Datum dieser Zulassung.
- Mitte, Fahrzeugdaten von oben nach unten:
  Zeile 1: B Datum der Erstzulassung | (2.1) HSN, 4 Ziffern | (2.2) 8 Zeichen, die ersten 3 sind die TSN, dahinter eine Prüfziffer
  Zeile 2: J Fahrzeugklasse | (4) Aufbauart
  Zeile 3: E FIN (17 Zeichen) | (3) Prüfziffer, EIN Zeichen
  danach D.1 Marke, D.2 in drei Zeilen (Typ, Variante, Version), D.3 Handelsbezeichnung, (2) Hersteller, (5) Fahrzeugart/Aufbau, V.9 | (14) Schadstoffklasse, P.3 Kraftstoff,
  vorletzte Zeile: (10) Code Kraftstoff | (14.1) Emissionsschlüssel | P.1 Hubraum
- Rechts: L Achsen | (9) | P.2/P.4 "kW/Drehzahl" (z. B. 85/6000) | T Höchstgeschwindigkeit; Maße (18)(19)(20) und G; F.1, F.2, Achslasten, O.1, O.2, S.1;
  (15.1)/(15.2)/(15.3) Reifen; R Farbe | (11); K Typgenehmigung; (6) Datum zu K | (17) | (16).
WICHTIG: 4-stellige Zahlen auf der rechten Seite (Massen F.1, F.2, G, Achslasten, Maße) sind NIE die HSN. Die HSN steht in Zeile 1 direkt rechts neben dem Datum B.
Das Datum bei (6) rechts unten ist NICHT die Erstzulassung. V.7 (CO₂, z. B. 181) ist NICHT die Leistung – die Leistung ist die Zahl vor dem Schrägstrich bei P.2/P.4.
Lies nur ab, was wirklich erkennbar ist. Erfinde nichts. Nicht lesbar = Wert "" und confidence 0.
Felder: kennzeichen (A), erstzulassung (B, YYYY-MM-DD), datum_zulassung (I, YYYY-MM-DD), halter_name (C.1.1 und C.1.2), halter_adresse (C.1.3),
marke (D.1), typ_variante (D.2, alle drei Zeilen mit Leerzeichen), modell_handelsbezeichnung (D.3), fin (E), pruefziffer ((3), "-" falls Strich),
hsn ((2.1)), tsn (erste 3 Zeichen von (2.2)), kraftstoff (P.3), leistung_kw (Zahl), hubraum_ccm (P.1, Zahl), farbe (R), fahrzeugklasse (J),
schadstoffklasse (14, z. B. "EURO 4"), emissionsschluessel ((14.1)), reifen_achse1 ((15.1)), reifen_achse2 ((15.2)), naechste_hu (YYYY-MM).
Außerdem "zeilen": eine Abschrift ALLER Zeilen der Fahrzeugdaten (Mitte und rechts) und der Halterseite, von oben nach unten, Werte einer Zeile mit " | " getrennt, ohne die kleinen Feldcodes.
Antworte NUR mit JSON: {"kennzeichen":{"value":"","confidence":0}, …, "zeilen":["16.10.2006 | 0005 | AAM00001 9", …]}.`;

// Abschrift zeilenweise auswerten: feste Muster sind zuverlässiger als die Feldzuordnung der KI
export function parseRegistrationLines(lines) {
  const out = {};
  if (!Array.isArray(lines)) return out;
  const L = lines.map((l) => String(l || '').toUpperCase().replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 80);
  // kleine Feldcodes wie "2.1", "(15.1)", "P.3" entfernen, Datumsangaben bleiben erhalten
  const clean = (l) => l
    .replace(/\(\d{1,2}(?:\.\d)?\)/g, ' ')
    .replace(/(?<![\w.])[A-Z]\.\d(?:\.\d)?(?:\/[A-Z]\.\d)?(?![\w.])/g, ' ')
    .replace(/(?<![\d.])\d{1,2}\.\d(?![\d.])/g, ' ')
    .replace(/[|:;]/g, ' ').replace(/\s+/g, ' ').trim();
  const C = L.map(clean);
  const iso = (d, m, y) => `${y}-${m}-${d}`;
  // Zeile 1: B Datum | (2.1) HSN | (2.2) TSN + 5 Zeichen + Prüfziffer
  for (const l of C) {
    const m = l.match(/(\d{2})\.(\d{2})\.((?:19|20)\d{2}) (\d{4}) ([A-Z0-9]{3}) ?([A-Z0-9]{5})(?: ([0-9X]))?\b/);
    if (m) { out.erstzulassung = iso(m[1], m[2], m[3]); out.hsn = m[4]; out.tsn = m[5].replace(/O/g, '0'); break; }
  }
  // FIN mit Prüfziffer (3) dahinter
  for (const l of C) {
    const m = l.match(/\b([A-HJ-NPR-Z0-9]{17})\b(?: ([0-9X-]))?/);
    if (m && /[A-Z]/.test(m[1]) && /\d/.test(m[1])) { out.fin = m[1]; if (m[2]) out.pruefziffer = m[2] === '-' ? '' : m[2]; break; }
  }
  // P.2/P.4 Leistung/Drehzahl, z. B. 85/6000
  for (const l of C) {
    const m = l.match(/(?:^| )(\d{1,4}(?:[.,]\d)?) ?\/ ?(\d{4,5})(?: |$)/);
    if (m && Number(m[2]) >= 1000 && Number(m[2]) <= 20000) { out.leistung_kw = Math.round(Number(m[1].replace(',', '.'))); break; }
  }
  // (10) | (14.1) | P.1, z. B. "0001 0462 1596"
  for (const l of C) {
    const m = l.match(/^(\d{4}) ([0-9A-Z]{4}) (\d{2,5}|-)$/);
    if (m) { out.emissionsschluessel = m[2]; if (m[3] !== '-') out.hubraum_ccm = Number(m[3]); break; }
  }
  // Nach der FIN-Zeile: D.1 Marke, dann bis zu drei kurze Zeilen D.2 (Typ, Variante, Version), dann D.3 Handelsbezeichnung
  const fi = C.findIndex((l) => out.fin && l.includes(out.fin));
  if (fi >= 0 && C[fi + 1] && /^[A-Z][A-Z0-9 .\-&]{1,30}$/.test(C[fi + 1])) {
    out.marke = L[fi + 1].replace(/\s*\|.*$/, '');
    const d2 = []; let j = fi + 2;
    while (j < C.length && d2.length < 3 && /^[A-Z0-9][A-Z0-9\-/]{0,11}$/.test(C[j])) { d2.push(C[j]); j++; }
    if (d2.length) out.typ_variante = d2.join(' ');
    if (d2.length && C[j] && /[A-Z]/.test(C[j]) && C[j].length <= 40 && !/[*\/]/.test(C[j])) out.modell_handelsbezeichnung = L[j];
    out._vehicle_text = C.slice(fi).join(' ');
  }
  const tyres = [];
  C.forEach((l) => { const re = /(\d{3}\/\d{2} ?Z?R ?\d{2}(?: ?C)? ?\d{2,3}(?:\/\d{2,3})? ?[A-Z]{1,2}\b)/g; let m; while ((m = re.exec(l))) tyres.push(m[1].replace(/\s+/g, ' ')); });
  if (tyres[0]) out.reifen_achse1 = tyres[0];
  if (tyres[1]) out.reifen_achse2 = tyres[1];
  for (const l of C) { const m = l.match(/\bEURO ?(\d[A-Z]?(?:[- ]?(?:TEMP|ISC|FCM|D|C|B|A)){0,2})\b/); if (m) { out.schadstoffklasse = 'EURO ' + m[1].replace(/ /g, '-'); break; } }
  for (const l of C) { const m = l.match(/^(BENZIN|DIESEL|ELEKTRO|HYBR[A-Z/ ]*|ERDGAS[A-Z ]*|FLÜSSIGGAS[A-Z ]*|LPG|CNG|WASSERSTOFF)\b/); if (m) { out.kraftstoff = m[1].charAt(0) + m[1].slice(1).toLowerCase(); break; } }
  // Nächste HU: Monat/Jahr ohne Tag, nur wenn eindeutig
  const hu = new Set(); C.forEach((l) => { const re = /(?<![\d.])(0[1-9]|1[0-2])[./](20\d{2})(?![\d.])/g; let m; while ((m = re.exec(l))) hu.add(`${m[2]}-${m[1]}`); });
  if (hu.size === 1) out.naechste_hu = [...hu][0];
  return out;
}


// Prüfziffer zur FIN (Feld 3) nach KBA, Modulo 11: Buchstaben A–I und J–R = 1–9, S–Z = 2–9; Gewichte 9..2,10,9..2; Rest 10 = X
const FIN_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2, 10, 9, 8, 7, 6, 5, 4, 3, 2];
function finCharValue(ch) {
  if (/\d/.test(ch)) return Number(ch);
  const c = ch.charCodeAt(0);
  if (c >= 65 && c <= 73) return c - 64; // A–I
  if (c >= 74 && c <= 82) return c - 73; // J–R
  if (c >= 83 && c <= 90) return c - 81; // S–Z
  return null;
}
export function finCheckDigit(fin) {
  const v = String(fin || '').toUpperCase();
  if (!/^[A-Z0-9]{17}$/.test(v)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) { const n = finCharValue(v[i]); if (n == null) return null; sum += n * FIN_WEIGHTS[i]; }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}
// Typische Lesefehler bei Fotos: je Stelle eine Verwechslung probieren, bis die Prüfziffer passt
const FIN_CONFUSION = { '0': ['D'], D: ['0'], '8': ['B'], B: ['8'], '5': ['S'], S: ['5'], '2': ['Z'], Z: ['2'], '6': ['G'], G: ['6'], '4': ['A'], A: ['4'], U: ['V'], V: ['U'] };
function finRepair(fin, check) {
  const found = new Map();
  for (let i = 0; i < 17; i++) {
    for (const alt of FIN_CONFUSION[fin[i]] || []) {
      const cand = fin.slice(0, i) + alt + fin.slice(i + 1);
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(cand) || finCheckDigit(cand) !== check) continue;
      // Plausibilität: hinten (laufende Nummer) stehen fast immer Ziffern, vorne (Herstellercode) meist Buchstaben
      const digit = /\d/.test(alt);
      const score = i >= 11 ? (digit ? 2 : -2) : i < 3 ? (digit ? -1 : 1) : 0;
      found.set(cand, score);
    }
  }
  return [...found.entries()].sort((x, y) => y[1] - x[1]);
}

export function normalizeRegistration(raw) {
  const r = { ...(raw || {}) }; const out = {};
  // Werte aus der zeilenweisen Abschrift haben Vorrang, wenn ihr festes Muster passt
  const parsed = parseRegistrationLines(r.zeilen);
  const vehicleText = parsed._vehicle_text || ''; delete parsed._vehicle_text;
  for (const [k, v] of Object.entries(parsed)) if (v !== '' && v != null) r[k] = { value: v, confidence: 0.95 };
  // Halter steht nur auf der Halterseite – Wörter aus den Fahrzeugdaten sind ein Lesefehler
  if (vehicleText && r.halter_name) {
    const hv = String(r.halter_name && typeof r.halter_name === 'object' ? r.halter_name.value : r.halter_name || '').toUpperCase();
    const words = hv.split(/[^A-ZÄÖÜ0-9]+/).filter((w) => w.length >= 3);
    if (words.length && words.filter((w) => vehicleText.includes(w)).length / words.length >= 0.5) {
      r.halter_name = { value: '', confidence: 0 };
      if (r.halter_adresse && typeof r.halter_adresse === 'object') r.halter_adresse = { ...r.halter_adresse, confidence: Math.min(Number(r.halter_adresse.confidence) || 0.5, 0.5) };
    }
  }
  for (const k of REG_FIELDS) {
    let f = r[k]; let v = f && typeof f === 'object' && 'value' in f ? f.value : f; let c = f && typeof f === 'object' ? Number(f.confidence) : 0.5;
    if (!Number.isFinite(c)) c = 0.5; c = Math.max(0, Math.min(1, c));
    if (v === null || v === undefined) v = '';
    if (k === 'leistung_kw' || k === 'hubraum_ccm') { const n = Number(String(v).replace(/[^\d.,]/g, '').replace(',', '.')); v = Number.isFinite(n) && n > 0 && n < 20000 ? Math.round(n) : 0; if (!v) c = 0; }
    else v = String(v).trim().slice(0, 120);
    out[k] = { value: v, confidence: v === '' || v === 0 ? 0 : c };
  }
  const fix = (k, re, transform) => { const f = out[k]; if (!f.value) return; const v = transform ? transform(String(f.value)) : String(f.value); f.value = v; if (!v) f.confidence = 0; else if (!re.test(v)) f.confidence = Math.min(f.confidence, 0.4); };
  fix('fin', /^[A-HJ-NPR-Z0-9]{17}$/, v => v.toUpperCase().replace(/[\s-]/g, ''));
  fix('pruefziffer', /^[0-9X]$/, v => v.toUpperCase().replace(/[^0-9X]/g, '').slice(0, 1));
  fix('hsn', /^\d{4}$/, v => v.replace(/\s/g, ''));
  fix('tsn', /^[A-Z0-9]{3}$/, v => v.toUpperCase().replace(/\s/g, '').slice(0, 3));
  const isoDate = v => { const m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v.slice(0, 10); };
  const isoMonth = v => { const m = v.match(/^(\d{1,2})[./](\d{2,4})$/); if (m) return `${m[2].length === 2 ? '20' + m[2] : m[2]}-${m[1].padStart(2, '0')}`; return isoDate(v); };
  fix('erstzulassung', /^\d{4}-\d{2}-\d{2}$/, isoDate);
  fix('datum_zulassung', /^\d{4}-\d{2}-\d{2}$/, isoDate);
  fix('naechste_hu', /^\d{4}-\d{2}(-\d{2})?$/, isoMonth);
  fix('fahrzeugklasse', /^[A-Z][0-9A-Z]{0,3}$/, v => v.toUpperCase().replace(/\s/g, ''));
  fix('emissionsschluessel', /^[0-9A-Z]{2,6}$/, v => v.toUpperCase().replace(/\s/g, ''));
  for (const k of ['reifen_achse1', 'reifen_achse2']) fix(k, /\d{3}\/\d{2}\s?Z?R\s?\d{2}/i, v => v.toUpperCase().replace(/\s+/g, ' '));
  out.kennzeichen.value = String(out.kennzeichen.value).toUpperCase();

  if (out.datum_zulassung.value && out.datum_zulassung.value === out.erstzulassung.value) out.datum_zulassung.confidence = Math.min(out.datum_zulassung.confidence, 0.5);
  // FIN gegen die Prüfziffer aus Feld (3) prüfen – fängt die meisten Lesefehler ab
  const fin = String(out.fin.value || ''); const check = String(out.pruefziffer.value || '');
  out.fin_pruefung = { status: 'ohne', hinweis: '' };
  if (fin.length === 17 && /^[0-9X]$/.test(check)) {
    if (finCheckDigit(fin) === check) { out.fin_pruefung = { status: 'ok', hinweis: 'FIN passt zur Prüfziffer (Feld 3).' }; out.fin.confidence = Math.max(out.fin.confidence, 0.97); }
    else {
      const ranked = finRepair(fin, check); const cands = ranked.map((x) => x[0]);
      const fixed = ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
      if (fixed) { out.fin_pruefung = { status: 'korrigiert', hinweis: `FIN anhand der Prüfziffer korrigiert (gelesen: ${fin}).`, gelesen: fin }; out.fin.value = fixed; out.fin.confidence = 0.8; }
      else { out.fin_pruefung = { status: 'abweichend', hinweis: `FIN passt nicht zur Prüfziffer (Feld 3) – bitte Zeichen für Zeichen mit dem Schein vergleichen.${cands.length > 1 && cands.length <= 3 ? ' Möglich wäre: ' + cands.join(' oder ') + '.' : ''}`, kandidaten: cands.slice(0, 3) }; out.fin.confidence = Math.min(out.fin.confidence, 0.3); }
    }
  }
  return out;
}

// Wie vollständig ist ein Scan? complete = alles Wichtige für den Auftrag sicher gelesen
export function registrationScore(r) {
  const ok = (k, min = 0.7) => r && r[k] && r[k].value !== '' && r[k].value !== 0 && Number(r[k].confidence) >= min;
  const finOk = ok('fin') && /^[A-HJ-NPR-Z0-9]{17}$/.test(String(r.fin.value)) && (!r.fin_pruefung || r.fin_pruefung.status !== 'abweichend');
  const hsnOk = ok('hsn') && /^\d{4}$/.test(String(r.hsn.value));
  const tsnOk = ok('tsn') && /^[A-Z0-9]{3}$/.test(String(r.tsn.value));
  let score = (finOk ? 4 : 0) + (hsnOk ? 3 : 0) + (tsnOk ? 3 : 0);
  for (const k of ['kennzeichen', 'erstzulassung', 'marke', 'leistung_kw', 'hubraum_ccm', 'kraftstoff', 'modell_handelsbezeichnung']) if (ok(k)) score += 1;
  if (r && r.fin_pruefung && r.fin_pruefung.status === 'ok') score += 2;
  return { score, complete: finOk && hsnOk && tsnOk && ok('kennzeichen', 0.5) };
}

export async function registrationScan(key, images, env) {
  limitPerHour('reg:' + key, SCAN_PER_HOUR);
  if (!images.length) throw new AiError(400, 'params', 'Kein Foto übermittelt.');
  const parsed = await visionJson(env, REG_PROMPT, images.slice(0, 2), 1800);
  return normalizeRegistration(parsed);
}

/* ---------- Eingangsbeleg (Rechnung, Quittung) ---------- */
export const RECEIPT_CATEGORIES = ['Ersatzteile', 'Reifen', 'Öl und Betriebsstoffe', 'Werkzeug', 'Fremdleistung', 'Miete', 'Strom/Gas/Wasser', 'Versicherung', 'Fahrzeugkosten', 'Werbung', 'Telefon/Internet', 'Software/EDV', 'Bürobedarf', 'Entsorgung', 'Reparatur/Instandhaltung', 'Porto/Versand', 'Bewirtung', 'Reisekosten', 'Fortbildung', 'Beiträge/Gebühren', 'Leasing', 'Sonstiges'];
const RECEIPT_PROMPT = `Du liest ein Foto einer deutschen Eingangsrechnung oder Quittung einer Kfz-Werkstatt.
Lies nur ab, was wirklich erkennbar ist. Erfinde nichts. Nicht lesbar = "".
Felder: lieferant (Firmenname des Ausstellers), belegnummer (Rechnungs- oder Belegnummer), datum (Rechnungsdatum, YYYY-MM-DD),
faellig (Zahlungsziel/fällig am, YYYY-MM-DD, nur falls angegeben), brutto (Gesamtbetrag inkl. MwSt als Zahl), netto (Zahl), mwst (MwSt-Betrag als Zahl),
mwst_satz (19, 7 oder 0), beschreibung (kurz, was gekauft wurde, max. 80 Zeichen), kategorie (genau eine aus: ${RECEIPT_CATEGORIES.join(', ')}),
iban (IBAN des Lieferanten, nur falls aufgedruckt).
Antworte NUR mit JSON: {"lieferant":"","belegnummer":"","datum":"","faellig":"","brutto":0,"netto":0,"mwst":0,"mwst_satz":19,"beschreibung":"","kategorie":"","iban":""}`;
const num2 = v => { if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; let t = String(v || '').replace(/[^\d.,-]/g, ''); if (!t) return null; if (t.includes(',') && t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, ''); const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const isoDay = v => { const s = String(v || '').trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; } return ''; };
export function normalizeReceipt(raw) {
  const r = raw || {};
  let gross = num2(r.brutto), net = num2(r.netto), vat = num2(r.mwst);
  let rate = r.mwst_satz !== '' && r.mwst_satz != null && [19, 7, 0].includes(Number(String(r.mwst_satz).replace('%', ''))) ? Number(String(r.mwst_satz).replace('%', '')) : null;
  if (gross != null && gross < 0) gross = null;
  if (rate == null && gross && net) { const q = gross / net - 1; rate = Math.abs(q - 0.19) < 0.01 ? 19 : Math.abs(q - 0.07) < 0.01 ? 7 : Math.abs(q) < 0.005 ? 0 : 19; }
  if (rate == null) rate = 19;
  if (gross == null && net != null) gross = Math.round(net * (1 + rate / 100) * 100) / 100;
  if (gross != null && (net == null || Math.abs(net * (1 + rate / 100) - gross) > 0.05)) net = Math.round(gross / (1 + rate / 100) * 100) / 100;
  if (gross != null && net != null) vat = Math.round((gross - net) * 100) / 100;
  const cat = RECEIPT_CATEGORIES.find(c => c.toLowerCase() === String(r.kategorie || '').toLowerCase()) || '';
  const iban = String(r.iban || '').toUpperCase().replace(/\s+/g, '');
  return {
    supplier_name: String(r.lieferant || '').trim().slice(0, 120), receipt_number: String(r.belegnummer || '').trim().slice(0, 60),
    receipt_date: isoDay(r.datum), due_date: isoDay(r.faellig), gross, net, vat, vat_rate: rate,
    description: String(r.beschreibung || '').trim().slice(0, 120), category: cat, iban: /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban) ? iban : '',
  };
}
export async function receiptScan(key, images, env) {
  limitPerHour('rcpt:' + key, SCAN_PER_HOUR);
  if (!images.length) throw new AiError(400, 'params', 'Kein Foto übermittelt.');
  return normalizeReceipt(await visionJson(env, RECEIPT_PROMPT, images.slice(0, 2), 700));
}

export async function tireScanImages(key, images, env) {
  limitPerHour('scan:' + key, SCAN_PER_HOUR);
  if (!images.length) throw new AiError(400, 'params', 'Kein Foto übermittelt.');
  return normalizeTire(await visionJson(env, TIRE_PROMPT, images.slice(0, 3), 900));
}

/* ---------- Berichtsheft: Tätigkeiten eines Tages sammeln und als Vorschlag formulieren ----------
   Quelle: am Tablet erledigte Aufgaben, gebuchte Zeiten, Sprachberichte/Notizen und Diagnosen des Mitarbeiters.
   Ins Berichtsheft gehören keine Kundendaten – die KI bekommt nur Fahrzeugtyp und Tätigkeit. */
const BH_SYSTEM = `Du schreibst Einträge für das Berichtsheft (Ausbildungsnachweis) einer/eines Auszubildenden in der Kfz-Werkstatt.
Aus den TÄTIGKEITEN des Tages formulierst du kurze, sachliche Stichpunkte in Ich-Form und Vergangenheit, z. B. "- Bremsbeläge und Bremsscheiben an der Vorderachse eines VW Golf 7 erneuert".
Regeln:
- Nur Tätigkeiten aus den Daten. Nichts erfinden, keine zusätzlichen Arbeitsschritte, keine Messwerte, die nicht genannt sind.
- Keine Kundennamen, Kennzeichen, FIN, Preise oder Auftragsnummern. Fahrzeug nur als Marke/Modell.
- Fachlich korrekte Begriffe. Gleichartige Tätigkeiten zusammenfassen. Höchstens 8 Stichpunkte, keine Zeitangaben.
- Antworte NUR mit der Liste, jede Zeile beginnt mit "- ". Keine Überschrift, keine Einleitung.`;
const berlinDay = iso => { const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(String(iso)) ? iso : iso + 'Z'); return Number.isFinite(t) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(t)) : ''; };
export function berichtsheftItems(name, data, notes, date) {
  const orders = Object.fromEntries((data.orders || []).map(o => [o.id, o]));
  const veh = id => { const o = orders[id]; return o ? [o.vehicle_brand, o.vehicle_model].filter(Boolean).join(' ') : ''; };
  const wts = (data.worktimes || []).filter(w => w.employee_name === name && berlinDay(w.start_timestamp) === date);
  const myNotes = (notes || []).filter(n => n.author_name === name && berlinDay(n.created_date) === date);
  const items = [];
  (data.tasks || []).filter(t => t.status === 'erledigt' && t.completed_by === name && berlinDay(t.completed_date) === date).forEach(t => {
    const booked = wts.filter(w => w.task_id === t.id).reduce((s, w) => s + (Number(w.duration_minutes) || 0), 0);
    const report = myNotes.filter(n => n.task_id === t.id && !/^OBD-Diagnose/.test(n.content || '')).map(n => String(n.content).slice(0, 400)).join(' ');
    items.push({ kind: 'aufgabe', title: String(t.title || 'Aufgabe').slice(0, 120), vehicle: veh(t.order_id), minutes: booked || Number(t.estimated_minutes) || 0, detail: report });
  });
  // Zeiten ohne erledigte Aufgabe (z. B. noch offen oder freie Tätigkeit)
  const done = new Set(items.map(i => i.title));
  wts.filter(w => !(data.tasks || []).some(t => t.id === w.task_id && t.status === 'erledigt' && t.completed_by === name)).forEach(w => {
    const t = (data.tasks || []).find(x => x.id === w.task_id);
    const title = String((t && t.title) || w.description || '').slice(0, 120); if (!title || done.has(title)) return;
    done.add(title); items.push({ kind: 'mitgearbeitet', title, vehicle: veh(w.order_id), minutes: Number(w.duration_minutes) || 0, detail: '' });
  });
  myNotes.filter(n => /^OBD-Diagnose \(Fahrzeug ausgelesen\)/.test(n.content || '')).forEach(n => {
    items.push({ kind: 'diagnose', title: 'Fehlerspeicher mit OBD-Diagnosegerät ausgelesen', vehicle: veh(n.order_id), minutes: 0, detail: (String(n.content).match(/\b[PCBU][0-3][0-9A-F]{3}\b/g) || []).slice(0, 5).join(', ') });
  });
  return items;
}
export function berichtsheftFallback(items) {
  return items.map(i => `- ${i.title}${i.vehicle ? ' (' + i.vehicle + ')' : ''}${i.kind === 'mitgearbeitet' ? ' – mitgearbeitet' : ''}${i.kind === 'diagnose' && i.detail ? ', Fehlercodes ' + i.detail : ''}`).join('\n');
}
export async function berichtsheftDraft(env, name, data, notes, date, useAi) {
  const items = berichtsheftItems(name, data, notes, date);
  const minutes = items.reduce((s, i) => s + i.minutes, 0);
  const base = { ok: true, date, items: items.map(({ kind, title, vehicle, minutes }) => ({ kind, title, vehicle, minutes })), minutes };
  if (!items.length) return { ...base, text: '', ai: false };
  if (useAi && env.AI) {
    try {
      const facts = items.map((i, n) => `${n + 1}. ${i.kind === 'mitgearbeitet' ? '(mitgearbeitet, noch nicht abgeschlossen) ' : ''}${i.title}${i.vehicle ? ' – Fahrzeug: ' + i.vehicle : ''}${i.detail ? ' – Bericht/Details: ' + i.detail : ''}`).join('\n');
      const r = await runAi(env, TEXT_MODEL, { messages: [{ role: 'system', content: BH_SYSTEM }, { role: 'user', content: `TÄTIGKEITEN am ${deDate(date)}:\n${facts}` }], max_tokens: 400, temperature: 0.2 });
      const lines = textOf(r).split('\n').map(l => l.trim().replace(/^[*•–]\s+/, '- ')).filter(l => /^- \S/.test(l)).slice(0, 10)
        .map(l => l.replace(/\b[A-ZÄÖÜ]{1,3}-[A-ZÄÖÜ]{1,2}\s?\d{1,4}[EH]?\b/g, '').replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim());
      if (lines.length) return { ...base, text: lines.join('\n'), ai: true };
    } catch (e) { console.log('bh_ai', String((e && e.code) || e)); }
  }
  return { ...base, text: berichtsheftFallback(items), ai: false };
}


/* ---------- Dashboard-ALEX: Antworten + Entwürfe (Auftrag, Termin, Teilebestellung) ----------
   Entwürfe werden ohne KI aus Text + Werkstattdaten gebaut (zuverlässig, kein Kontingent);
   angelegt wird erst nach Bestätigung im Dashboard (alexExecute). */
const PLATE_RE = /\b([A-ZÄÖÜ]{1,3})[-\s]([A-Z]{1,2})[-\s]?(\d{1,4}[EH]?)\b/;
const DAY_NAMES = ['sonntag', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag'];
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const toMin = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function draftIntent(question) {
  const q = norm(question);
  if (/(neue[rnms]?\s+auftrag|auftrag\s+(an)?legen|auftrag\s+erstellen|auftrag\s+für|auftrag\s+fuer)/.test(q)) return 'auftrag';
  if (/(teilebestellung|nachbestell|bestell(e|en)\b|bestellung\s+(für|fuer|anlegen))/.test(q) && !/(wann|wurde|ist .* bestellt|status)/.test(q)) return 'teilebestellung';
  if (/\btermin/.test(q) && !/(wie voll|auslast|kapazit|frei\?|welche termine|was steht)/.test(q)) return 'termin';
  return null;
}
function findPlate(question) {
  const m = String(question || '').toUpperCase().match(PLATE_RE);
  return m ? `${m[1]}-${m[2]} ${m[3]}` : '';
}
function knownVehicle(plate, data) {
  if (!plate) return null;
  const k = plateKey(plate);
  const hits = [...data.orders].filter(o => plateKey(o.license_plate) === k).sort((a, b) => String(b.created_date).localeCompare(String(a.created_date)));
  if (hits[0]) return hits[0];
  const ap = (data.appointments || []).find(a => plateKey(a.license_plate) === k);
  return ap || null;
}
function matchServices(question, services) {
  const qt = ftokens(question);
  return services.filter(s => s.is_active !== false).filter(s => {
    const st = ftokens(s.name).filter(w => w.length > 3);
    return st.length && st.some(w => qt.some(x => sameStem(x, w) || (x.length >= 3 && w.startsWith(x))));
  }).slice(0, 4);
}
function leastBusyMechanic(data) {
  const mechs = data.employees.filter(e => e.is_active !== false && e.role === 'mechaniker');
  if (!mechs.length) return '';
  const load = n => data.orders.filter(o => OPEN(o) && o.status !== 'abholbereit' && o.assigned_mechanic === n).length;
  return mechs.map(e => ({ n: e.name, l: load(e.name) })).sort((a, b) => a.l - b.l)[0].n;
}
// Freie Zeitfenster: Mo–Fr 08:00–17:00 (Sa bis 12:00), so viele parallele Termine wie Mechaniker
export function freeSlots(question, data, duration, count = 3) {
  const q = norm(question); const today = berlinDate(0);
  let start = addDaysIso(today, 1), end = addDaysIso(today, 14);
  if (/übermorgen|uebermorgen/.test(q)) { start = end = addDaysIso(today, 2); }
  else if (/\bmorgen\b/.test(q)) { start = end = addDaysIso(today, 1); }
  else if (/\bheute\b/.test(q)) { start = end = today; }
  else if (/nächste woche|naechste woche|kommende woche/.test(q)) { const toMon = (8 - dow(today)) % 7 || 7; start = addDaysIso(today, toMon); end = addDaysIso(start, 5); }
  else { const d = DAY_NAMES.findIndex(n => q.includes(n)); if (d >= 0) { let off = (d - dow(today) + 7) % 7 || 7; start = end = addDaysIso(today, off); } }
  const mech = Math.max(1, data.employees.filter(e => e.is_active !== false && e.role !== 'serviceberater').length);
  const appts = (data.appointments || []).filter(a => a.status !== 'storniert');
  const nowMin = (() => { const p = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date()).split(':'); return +p[0] * 60 + +p[1]; })();
  const out = [];
  for (let iso = start; iso <= end && out.length < count; iso = addDaysIso(iso, 1)) {
    const wd = dow(iso); if (wd === 0) continue;
    const close = wd === 6 ? 12 * 60 : 17 * 60;
    const day = appts.filter(a => a.appointment_date === iso).map(a => { const s0 = toMin(a.time_slot) ?? 8 * 60; return [s0, s0 + (Number(a.estimated_duration) || 30)]; });
    for (let m = 8 * 60; m + duration <= close; m += 30) {
      if (iso === today && m < nowMin + 30) continue;
      const busy = day.filter(([a, b]) => a < m + duration && b > m).length;
      if (busy < mech) { out.push({ date: iso, time_slot: fromMin(m), end_time: fromMin(m + duration) }); break; }
    }
  }
  return out;
}
export function buildDraft(kind, question, data, opts = {}) {
  const plate = findPlate(question);
  const known = knownVehicle(plate, data);
  const services = matchServices(question, data.services || []);
  const warnings = [];
  const strip = t => String(t || '').replace(PLATE_RE, ' ').replace(/(neue[rnms]?\s+auftrag|auftrag\s+(an)?legen|auftrag\s+erstellen|auftrag)\s*(für|fuer)?/ig, ' ').replace(/^[\s,:.-]+|[\s,:.-]+$/g, '').replace(/\s{2,}/g, ' ');
  if (kind === 'auftrag') {
    if (!plate) warnings.push('Kein Kennzeichen erkannt – bitte ergänzen.');
    else if (!known) warnings.push('Kennzeichen noch nicht im System – Kunde und Fahrzeug bitte ergänzen.');
    const dur = services.reduce((s, x) => s + (Number(x.estimated_duration_minutes) || 30), 0);
    let planned = null;
    if (dur) { const t = new Date(Date.now() + (dur + 60) * 60_000); planned = t.toISOString(); }
    const fields = {
      customer_name: known ? known.customer_name || '' : '', license_plate: known && known.license_plate ? known.license_plate : plate,
      vehicle_brand: known ? known.vehicle_brand || '' : '', vehicle_model: known ? known.vehicle_model || '' : '',
      mileage: known && known.mileage ? known.mileage : undefined, phone: known ? known.phone || '' : '', email: known ? known.email || '' : '',
      vin: known ? known.vin || '' : '', hsn: known ? known.hsn || '' : '', tsn: known ? known.tsn || '' : '', next_hu: known ? known.next_hu || '' : '',
      description: strip(question).slice(0, 300), priority: /eilig|dringend|sofort/i.test(question) ? 'eilig' : 'normal',
      assigned_mechanic: leastBusyMechanic(data),
    };
    return { type: 'auftrag', fields, service_ids: services.map(x => x.id), services: services.map(x => ({ id: x.id, name: x.name, duration: Number(x.estimated_duration_minutes) || 30 })),
      suggested_mechanic: fields.assigned_mechanic, planned_completion: planned, warnings };
  }
  if (kind === 'termin') {
    const svc = services[0];
    const dur = svc ? Number(svc.estimated_duration_minutes) || 60 : (/reifen|räder|raeder/i.test(question) ? 30 : 60);
    const proposals = freeSlots(question, data, dur, 3);
    if (!proposals.length) warnings.push('Im gewünschten Zeitraum ist nichts frei – bitte anderen Tag wählen.');
    if (!plate && !known) warnings.push('Kein Kennzeichen erkannt – Kunde bitte ergänzen.');
    const cat = svc ? svc.category : '';
    const type = cat === 'reifen' || /reifen|räder|raeder/i.test(question) ? 'reifenwechsel' : cat === 'inspektion' || cat === 'oel_wartung' || /inspektion|service|öl|oel/i.test(question) ? 'inspektion' : 'fahrzeugabgabe';
    const fields = {
      customer_name: known ? known.customer_name || '' : '', license_plate: known && known.license_plate ? known.license_plate : plate,
      vehicle_brand: known ? known.vehicle_brand || '' : '', vehicle_model: known ? known.vehicle_model || '' : '',
      phone: known ? known.phone || '' : '', email: known ? known.email || '' : '',
      service_name: svc ? svc.name : (strip(question).replace(/\btermin\b/ig, '').trim().slice(0, 80) || 'Termin'), service_id: svc ? svc.id : '',
      appointment_type: type, estimated_duration: dur,
    };
    return { type: 'termin', fields, proposals, warnings };
  }
  // Teilebestellung
  const qn = norm(question);
  const qtyM = qn.match(/(\d+)\s*(x|stück|stk|satz|sätze|liter|l)\b/);
  const inv = (data.inventory || []);
  const qt = tokens(question).filter(w => w.length > 3 && !/bestell|nachbestell|teilebestellung|bitte/.test(w));
  const item = inv.find(i => { const hay = norm([i.name, i.part_number].join(' ')); return qt.some(w => hay.includes(w.replace(/(en|er|e|n|s)$/, ''))); });
  const fields = {
    part_name: item ? item.name : question.replace(/(teilebestellung|nachbestellen|bestellen|bestelle|bestellung)\s*(für|fuer|von)?/ig, '').replace(/\d+\s*(x|stück|stk)\b/ig, '').trim().slice(0, 120),
    part_number: item ? item.part_number || '' : '', quantity: qtyM ? +qtyM[1] : (item && item.reorder_quantity ? Number(item.reorder_quantity) : 1),
    supplier_name: item ? item.supplier_name || '' : '', inventory_item_id: item ? item.id : '',
    related_order_id: opts.orderId || '',
  };
  if (!item) warnings.push('Kein passender Lagerartikel gefunden – Teilenummer und Lieferant bitte ergänzen.');
  return { type: 'teilebestellung', fields, warnings };
}
const DRAFT_TEXT = {
  auftrag: d => `Ich habe einen Auftrags-Entwurf vorbereitet${d.fields.customer_name ? ` für ${d.fields.customer_name}` : ''}${d.services.length ? ` mit ${d.services.map(s => s.name).join(', ')}` : ''}. Bitte prüfen, bei Bedarf „Ändern“ und dann „Anlegen“.`,
  termin: d => d.proposals.length ? `Ich habe ${d.proposals.length} freie Termine gefunden. Vorschlag wählen und mit „Anlegen“ bestätigen.` : 'Im gewünschten Zeitraum habe ich keinen freien Termin gefunden.',
  teilebestellung: d => `Ich habe eine Teilebestellung für ${d.fields.quantity} × ${d.fields.part_name || 'Teil'} vorbereitet. Bitte prüfen und mit „Anlegen“ bestätigen.`,
};

export async function alexDashboard(db, sess, body, env, data) {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).filter(m => m && m.role === 'user' && typeof m.content === 'string');
  const q = msgs.length ? msgs[msgs.length - 1].content.slice(0, 1500) : '';
  if (!q.trim()) throw new AiError(400, 'params', 'Keine Frage übermittelt.');
  const kind = draftIntent(q);
  if (kind) {
    const draft = buildDraft(kind, q, data, { orderId: body.order_id });
    return { ok: true, answer: DRAFT_TEXT[kind](draft), draft, cards: [], sources: [], used_general_knowledge: false };
  }
  try {
    const r = await alexAsk(db, sess, { ...body, channel: 'dashboard' }, env, data);
    return { ...r, answer: String(r.answer).replace(/\*\*/g, '').replace(/^#+\s*/gm, ''), sources: (r.sources || []).map((s, i) => ({ id: 's' + i, ...s })) };
  } catch (e) {
    // KI nicht verfügbar (Tageskontingent leer, gestört, nicht eingerichtet): trotzdem helfen – Fehlercodes, Karten, Wissenseintrag
    if (!e || !['ai_quota', 'not_available', 'ai_error'].includes(e.code)) throw e;
    const why = e.code === 'ai_quota' ? 'Das KI-Tageskontingent ist gerade aufgebraucht – ab 2 Uhr nachts antworte ich wieder ausführlich.' : 'Die KI ist gerade nicht erreichbar – bitte gleich noch einmal fragen.';
    const kb = searchKb(await loadKb(db, sess.workshop_code), q, '');
    const qn = norm(q); const cards = [];
    if (/heute|steht.*an|zu tun|priorit|empfehl|überfällig|dringend/.test(qn)) { const rec = recommendations(data); if (rec.length) cards.push({ type: 'empfehlungen', items: rec }); }
    if (/voll|kapazit|auslast|frei|termin|woche|morgen/.test(qn)) cards.push(...capacityDays(data.appointments, data.employees));
    cards.push(...findCustomers(q, data));
    if (/lager|bestand|vorrätig|vorraetig|teil|haben wir/.test(qn)) cards.push(...findParts(q, data.inventory || []));
    const codeText = findCodes(q).map(describeCode).map(c => `${c.code}: ${c.text}${c.hint ? '\n' + c.hint : ''}`).join('\n\n');
    const safety = safetyFacts(qn).join('\n');
    const answer = [safety, codeText].filter(Boolean).join('\n\n') + (safety || codeText ? '\n\n' : '')
      + (kb.length ? `${kb[0].title}\n\n${String(kb[0].content).replace(/\*\*/g, '').slice(0, 900)}\n\n(${why} Antwort aus der Wissensdatenbank.)`
        : cards.length ? `Hier die passenden Daten aus der Werkstatt. (${why})`
        : safety || codeText ? `(${why})`
        : `${why} Fragen zu Aufträgen, Terminen, Kunden und Lager beantworte ich trotzdem mit den Werkstattdaten.`);
    return { ok: true, answer, cards, sources: kb.slice(0, 1).map((k, i) => ({ id: 's' + i, title: k.title })), used_general_knowledge: false, fallback: true };
  }
}
