/**
 * KI für AutoLeitwerk über Cloudflare Workers AI (Binding "AI" in wrangler.toml).
 * Kein API-Key, keine Kosten pro Anfrage: kostenloses Tageskontingent (Workers Free).
 * Ist es aufgebraucht, antwortet der Server mit `ai_quota` – das Tablet nutzt dann das lokale Wissen.
 *
 *  - alexAsk:  Werkstatt-Fragen mit Wissensdatenbank (AlexKnowledge) + Werkstattdaten
 *  - tireScan: Reifen-/Felgenfotos auswerten (Größe, DOT, Profil, Schäden)
 */
import KB_BUNDLED from '../../docs/alex_kb.json' with { type: 'json' };

export const TEXT_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const VISION_MODELS = ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/google/gemma-3-12b-it'];
const ASK_PER_HOUR = 40;
const SCAN_PER_HOUR = 15;

export class AiError extends Error {
  constructor(status, code, message) { super(code); this.status = status; this.code = code; this.extra = { message }; this.isHttp = true; }
}

/* ---------- Hilfen ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
const plateKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '');
const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ist', 'sind', 'ein', 'eine', 'einen', 'mit', 'bei', 'für', 'fuer', 'wie', 'was', 'wann', 'wo', 'wir', 'ich', 'du', 'auf', 'aus', 'von', 'zum', 'zur', 'den', 'dem', 'des', 'noch', 'auch', 'kann', 'muss', 'soll', 'haben', 'hat', 'gibt', 'nicht', 'mal', 'bitte', 'heute', 'alex']);
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
  try {
    return await env.AI.run(model, input);
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('ai_error', model, msg.slice(0, 300));
    if (/neuron|quota|daily|allocation|4006|exceeded/i.test(msg)) {
      throw new AiError(503, 'ai_quota', 'Das kostenlose KI-Tageskontingent ist aufgebraucht – ab 2 Uhr nachts wieder verfügbar.');
    }
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
export function searchKb(kb, question, vehicle) {
  const qt = [...new Set(ftokens(question + ' ' + (vehicle || '')))];
  const qf = fold(question + ' ' + (vehicle || ''));
  const codes = (qf.match(/\b[pcbu][0-9a-f]{4}\b/g) || []);
  const has = (list, w) => list.some(x => sameStem(x, w));
  return kb.map(k => {
    let score = 0;
    const kws = String(k.keywords || '').split(',').map(x => fold(x)).filter(w => w.length > 2);
    const kwTok = kws.flatMap(x => x.split(' '));
    const titleTok = ftokens(k.title); const contentTok = ftokens(k.content);
    qt.forEach(w => {
      if (has(kwTok, w) || has(titleTok, w)) score += 3;
      else if (w.length > 4 && has(contentTok, w)) score += 0.5;
    });
    kws.forEach(x => { if (x.length >= 3 && !kwTok.some(t => qt.some(w => sameStem(t, w))) && qf.includes(x)) score += 2; });
    const all = fold(k.title + ' ' + k.keywords + ' ' + k.content);
    codes.forEach(c => { if (all.includes(c)) score += 8; });
    if (k.brand && qf.includes(fold(k.brand))) score += 2;
    return { k, score };
  }).filter(x => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, 4).map(x => x.k);
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
    const tires = data.tire_sets.filter(t => norm(t.customer_name) === k);
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
const SYSTEM = `Du bist ALEX, der KI-Assistent im Werkstatt-Tablet „AutoLeitwerk“ einer freien KFZ-Werkstatt.
Regeln:
- Antworte immer auf Deutsch, kurz und praxisnah für Mechaniker und Serviceberater (höchstens ca. 150 Wörter).
- Arbeitsschritte als nummerierte Liste, wichtige Werte **fett**. Keine Einleitungsfloskeln.
- Nutze zuerst die WERKSTATTDATEN und die WISSENSEINTRÄGE. Wenn du einen Wissenseintrag verwendest, schreibe dahinter [Eintrag N].
- Erfinde niemals Drehmomente, Füllmengen, Teilenummern, Preise, Termine oder Bestände. Steht etwas nicht in den Daten, sage das und verweise auf Herstellerdaten bzw. das Dashboard.
- Bei Bremsen, Lenkung, Airbag und Hochvolt immer auf die Herstellervorgaben hinweisen.
- Du kannst selbst nichts anlegen oder ändern. Nur wenn ausdrücklich etwas angelegt werden soll: sag, dass das im Dashboard geht.
- Aufzählungen von Aufträgen kurz halten (höchstens 5, die wichtigsten zuerst) – die Details zeigt das Tablet als Karten.`;

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

  const order = body.order_id ? data.orders.find(o => o.id === body.order_id) : null;
  const vehicle = order ? [order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ') : '';
  const kb = searchKb(await loadKb(db, sess.workshop_code), q, vehicle);

  const cards = []; const facts = [];
  const today = berlinDate(0);
  facts.push(`Heute ist ${weekday(today)}, ${deDate(today)}.`);
  if (order) {
    const tasks = data.tasks.filter(t => t.order_id === order.id);
    facts.push('AKTUELLES FAHRZEUG (Auftrag):\n' + orderLine(order)
      + `\nFahrzeugdaten: ${[order.vin && 'FIN ' + order.vin, order.hsn && 'HSN ' + order.hsn, order.tsn && 'TSN ' + order.tsn, order.first_registration && 'EZ ' + deDate(order.first_registration), order.fuel_type, order.power_kw && order.power_kw + ' kW', order.displacement_ccm && order.displacement_ccm + ' ccm', order.mileage && order.mileage + ' km'].filter(Boolean).join(', ') || 'keine'}`
      + (tasks.length ? `\nAufgaben: ${tasks.map(t => `${t.title} (${t.status})`).join('; ')}` : ''));
  }
  const wantsToday = /heute|steht.*an|was (soll|muss|ist)|zu tun|priorit|empfehl|überfällig|ueberfaellig|dringend|eilig|tagesplan/.test(qn);
  const wantsCap = /voll|kapazit|auslast|frei|platz|termin|woche|morgen|montag|dienstag|mittwoch|donnerstag|freitag|samstag/.test(qn);
  const wantsParts = /lager|bestand|vorrätig|vorraetig|teil|haben wir|da\?|nachbestell/.test(qn);
  if (wantsToday) {
    const rec = recommendations(data);
    if (rec.length) cards.push({ type: 'empfehlungen', items: rec });
    facts.push('OFFENE AUFTRÄGE:\n' + (data.orders.filter(OPEN).slice(0, 15).map(orderLine).join('\n') || 'keine'));
    facts.push('EMPFEHLUNGEN (berechnet):\n' + (rec.map(r => `- ${r.title}: ${r.detail}`).join('\n') || 'keine'));
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

  const context = `WERKSTATTDATEN:\n${facts.join('\n\n')}\n\nWISSENSEINTRÄGE:\n` +
    (kb.length ? kb.map((k, i) => `[Eintrag ${i + 1}] ${k.title}${k.brand ? ' (' + k.brand + ')' : ''}\n${String(k.content).slice(0, 1400)}`).join('\n\n') : 'keine passenden Einträge');
  const r = await runAi(env, TEXT_MODEL, {
    messages: [{ role: 'system', content: SYSTEM + '\n\n' + context }, ...msgs],
    max_tokens: 700, temperature: 0.3,
  });
  const answer = textOf(r).trim();
  if (!answer) throw new AiError(502, 'ai_error', 'Die KI hat keine Antwort geliefert.');
  return {
    ok: true, answer, cards,
    sources: kb.map(k => ({ title: k.title })),
    used_general_knowledge: !kb.length && !cards.length && !order,
    model: 'workers-ai',
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
const REG_FIELDS = ['kennzeichen', 'erstzulassung', 'halter_name', 'halter_adresse', 'marke', 'typ_variante', 'modell_handelsbezeichnung', 'fin', 'hsn', 'tsn', 'kraftstoff', 'leistung_kw', 'hubraum_ccm', 'farbe', 'naechste_hu'];
const REG_PROMPT = `Du liest ein Foto der Vorderseite einer deutschen Zulassungsbescheinigung Teil I (Fahrzeugschein).
Lies nur ab, was wirklich erkennbar ist. Erfinde nichts. Nicht lesbar = Wert "" und confidence 0.
Felder: kennzeichen (A, z. B. "M-AB 1234"), erstzulassung (B, als YYYY-MM-DD), halter_name (C.1 Name/Firma), halter_adresse (C.1 Straße, PLZ Ort),
marke (D.1), typ_variante (D.2), modell_handelsbezeichnung (D.3), fin (E, genau 17 Zeichen ohne I/O/Q), hsn (2.1, genau 4 Ziffern),
tsn (2.2, die ersten 3 Zeichen), kraftstoff (P.3), leistung_kw (P.2, Zahl), hubraum_ccm (P.1, Zahl), farbe (R), naechste_hu (YYYY-MM-DD, nur falls sichtbar).
Antworte NUR mit JSON: {"kennzeichen":{"value":"","confidence":0}, ...} – für jedes der genannten Felder ein Objekt mit value und confidence (0–1).`;

export function normalizeRegistration(raw) {
  const r = raw || {}; const out = {};
  for (const k of REG_FIELDS) {
    let f = r[k]; let v = f && typeof f === 'object' && 'value' in f ? f.value : f; let c = f && typeof f === 'object' ? Number(f.confidence) : 0.5;
    if (!Number.isFinite(c)) c = 0.5; c = Math.max(0, Math.min(1, c));
    if (v === null || v === undefined) v = '';
    if (k === 'leistung_kw' || k === 'hubraum_ccm') { const n = Number(String(v).replace(/[^\d.,]/g, '').replace(',', '.')); v = Number.isFinite(n) && n > 0 && n < 20000 ? Math.round(n) : 0; if (!v) c = 0; }
    else v = String(v).trim().slice(0, 120);
    out[k] = { value: v, confidence: v === '' || v === 0 ? 0 : c };
  }
  const fix = (k, re, transform) => { const f = out[k]; if (!f.value) return; const v = transform ? transform(String(f.value)) : String(f.value); f.value = v; if (!re.test(v)) f.confidence = Math.min(f.confidence, 0.4); };
  fix('fin', /^[A-HJ-NPR-Z0-9]{17}$/, v => v.toUpperCase().replace(/[\s-]/g, ''));
  fix('hsn', /^\d{4}$/, v => v.replace(/\s/g, ''));
  fix('tsn', /^[A-Z0-9]{3}$/, v => v.toUpperCase().replace(/\s/g, '').slice(0, 3));
  const isoDate = v => { const m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v.slice(0, 10); };
  fix('erstzulassung', /^\d{4}-\d{2}-\d{2}$/, isoDate);
  fix('naechste_hu', /^\d{4}-\d{2}(-\d{2})?$/, isoDate);
  out.kennzeichen.value = String(out.kennzeichen.value).toUpperCase();
  return out;
}

export async function registrationScan(key, images, env) {
  limitPerHour('reg:' + key, SCAN_PER_HOUR);
  if (!images.length) throw new AiError(400, 'params', 'Kein Foto übermittelt.');
  const parsed = await visionJson(env, REG_PROMPT, images.slice(0, 2), 1000);
  return normalizeRegistration(parsed);
}

export async function tireScanImages(key, images, env) {
  limitPerHour('scan:' + key, SCAN_PER_HOUR);
  if (!images.length) throw new AiError(400, 'params', 'Kein Foto übermittelt.');
  return normalizeTire(await visionJson(env, TIRE_PROMPT, images.slice(0, 3), 900));
}
