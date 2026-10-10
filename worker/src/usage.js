/**
 * Verbrauchszähler für die CEO-Konsole (Kontingente des kostenlosen Plans).
 *
 * Gezählt wird im Speicher der Server-Instanz und höchstens alle 5 Minuten in den KV-Speicher
 * geschrieben – ein Schlüssel pro Instanz und Tag (_usage/<Tag>/<Instanz>), damit sich Instanzen nie
 * gegenseitig überschreiben und das KV-Schreiblimit (1.000/Tag) geschont wird. Die Konsole summiert alle.
 *
 * KI-Neuronen werden aus den Token-Angaben der Antwort berechnet (Cloudflare-Preisliste, Neuronen je
 * 1 Mio. Token). Fehlen die Angaben, gilt ein Erfahrungswert pro Anfrage. → Werte sind „geschätzt“.
 */
export const USAGE_PREFIX = '_usage/';
const FLUSH_MS = 5 * 60_000;
const INSTANCE = (() => { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); })();

// Kostenlose Kontingente (Stand Cloudflare Workers Free / Resend Free)
export const LIMITS = {
  neurons: { label: 'KI (Workers AI)', unit: 'Neuronen', day: 10_000 },
  requests: { label: 'Server-Anfragen', unit: 'Anfragen', day: 100_000 },
  emails: { label: 'E-Mails (Resend)', unit: 'Mails', day: 100, month: 3_000 },
  kv_writes: { label: 'Speicher-Schreibvorgänge (KV)', unit: 'Schreibvorgänge', day: 1_000 },
};
// Neuronen je 1 Mio. Token (Eingabe / Ausgabe)
const NEURON_RATES = {
  '@cf/mistralai/mistral-small-3.1-24b-instruct': [31_876, 50_488],
  '@cf/google/gemma-3-12b-it': [31_371, 50_560],
};
const FALLBACK_NEURONS = { text: 150, vision: 450 };

const berlinDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
const acc = new Map(); // Tag → Zähler
let lastFlush = Date.now();
let dirty = false;

function bucket(day) {
  if (!acc.has(day)) acc.set(day, { requests: 0, neurons: 0, ai_calls: 0, ai_errors: 0, ai_quota_hits: 0, ai_quota_first: null, emails: 0, emails_failed: 0, kv_writes: 0, photos: 0, workshops: {} });
  return acc.get(day);
}
export function count(key, n = 1, code) {
  const b = bucket(berlinDay());
  b[key] = (b[key] || 0) + n;
  if (code) { const w = b.workshops[code] || (b.workshops[code] = {}); w[key] = (w[key] || 0) + n; }
  dirty = true;
}
export function recordAi(model, result, kind, failed) {
  const b = bucket(berlinDay());
  if (failed === 'quota') { b.ai_quota_hits++; if (!b.ai_quota_first) b.ai_quota_first = new Date().toISOString(); dirty = true; return; }
  if (failed) { b.ai_errors++; dirty = true; return; }
  const u = result && result.usage;
  const rate = NEURON_RATES[model];
  let neurons;
  if (u && rate && (u.prompt_tokens || u.completion_tokens)) neurons = ((Number(u.prompt_tokens) || 0) * rate[0] + (Number(u.completion_tokens) || 0) * rate[1]) / 1e6;
  else neurons = FALLBACK_NEURONS[kind] || FALLBACK_NEURONS.text;
  b.neurons += neurons; b.ai_calls++;
  dirty = true;
}
// Nach einer Anfrage aufrufen: schreibt höchstens alle 5 Minuten (bzw. sofort, wenn force)
export function maybeFlush(env, ctx, force) {
  if (!env.PHOTOS || !dirty || (!force && Date.now() - lastFlush < FLUSH_MS)) return;
  lastFlush = Date.now(); dirty = false;
  const today = berlinDay();
  const writes = [];
  for (const [day, b] of acc) {
    b.kv_writes++; // dieser Schreibvorgang zählt mit
    writes.push(env.PHOTOS.put(`${USAGE_PREFIX}${day}/${INSTANCE}`, JSON.stringify(b), { expirationTtl: 40 * 86400 }).catch(e => console.log('usage_flush', String(e))));
    if (day !== today) acc.delete(day);
  }
  const p = Promise.all(writes);
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  return p;
}

function addInto(t, b) {
  for (const k of ['requests', 'neurons', 'ai_calls', 'ai_errors', 'ai_quota_hits', 'emails', 'emails_failed', 'kv_writes', 'photos']) t[k] = (t[k] || 0) + (Number(b[k]) || 0);
  if (b.ai_quota_first && (!t.ai_quota_first || b.ai_quota_first < t.ai_quota_first)) t.ai_quota_first = b.ai_quota_first;
  for (const [code, w] of Object.entries(b.workshops || {})) {
    const tw = t.workshops[code] || (t.workshops[code] = {});
    for (const [k, v] of Object.entries(w)) tw[k] = (tw[k] || 0) + (Number(v) || 0);
  }
}
const emptyDay = day => ({ day, requests: 0, neurons: 0, ai_calls: 0, ai_errors: 0, ai_quota_hits: 0, ai_quota_first: null, emails: 0, emails_failed: 0, kv_writes: 0, photos: 0, workshops: {} });

// Summe der letzten n Tage (Berliner Zeit) über alle Instanzen, inkl. noch nicht geschriebener Zähler dieser Instanz
export async function readUsage(env, days = 31) {
  const list = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(now.getTime() - i * 86400_000));
    list.push(d);
  }
  const result = [];
  for (const day of list) {
    const t = emptyDay(day);
    if (env.PHOTOS) {
      const keys = (await env.PHOTOS.list({ prefix: `${USAGE_PREFIX}${day}/` })).keys;
      const rows = await Promise.all(keys.filter(k => !(acc.has(day) && k.name.endsWith('/' + INSTANCE))).map(k => env.PHOTOS.get(k.name, { type: 'json' }).catch(() => null)));
      rows.filter(Boolean).forEach(b => addInto(t, b));
    }
    if (acc.has(day)) addInto(t, acc.get(day)); // eigene Instanz immer frisch aus dem Speicher
    t.neurons = Math.round(t.neurons);
    result.push(t);
  }
  const month = berlinDay().slice(0, 7);
  return { days: result, month_emails: result.filter(d => d.day.startsWith(month)).reduce((s, d) => s + d.emails, 0), limits: LIMITS, instance: INSTANCE };
}
