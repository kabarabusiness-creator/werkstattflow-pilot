/**
 * AutoLeitwerk API – eigener Server (Cloudflare Worker)
 *
 * Ersetzt die Base44-Funktionen workshopLogin, getTabletData, tabletAction und portalApi.
 * Liest und schreibt direkt in die Base44-Datenbank über die Apps-API (Personal Access Token),
 * damit Tablet und Kundenportal nicht vom Base44-Integrations-Kontingent abhängen.
 *
 * Secrets (in Cloudflare unter Settings → Variables and Secrets):
 *   BASE44_TOKEN  – Base44 Personal Access Token (Lesen + Schreiben)
 *   ADMIN_KEY     – frei gewähltes langes Passwort für /admin/export (Daten-Backup)
 * Bindings (wrangler.toml): PHOTOS (KV, Fotos), AI (Workers AI – ALEX + Reifenscan, kostenloses Tageskontingent)
 * Variablen (wrangler.toml):
 *   BASE44_APP_ID, ALLOWED_ORIGINS
 *
 * Gleiche Formate wie die Base44-Funktionen: Tablet-Token = 64 Hex-Zeichen,
 * gespeichert als SHA-256 in WorkshopSession; PIN = sha256(salt + ":" + pin).
 */

import { alexAsk, tireScan } from './ai.js';
import { handleFunction } from './dash.js';

const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const CACHE_MS = 30_000;
const WORKTIME_CAP_MIN = 720;
const TIME_SLOTS = ['08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30','13:00','13:30','14:00','14:30','15:00','15:30'];
const TABLET_ENTITIES = ['Order', 'OrderTask', 'Employee', 'WorkTime', 'Lift', 'Appointment', 'TireSet', 'Workshop'];

/* ---------------- Hilfsfunktionen ---------------- */
const enc = new TextEncoder();
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const nowIso = () => new Date().toISOString();
function berlinToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}
function berlinNowMinutes() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = p.split(':').map(Number); return h * 60 + m;
}

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || {}; } }

/* ---------------- Base44 Apps-API ---------------- */
class Base44 {
  constructor(env) {
    if (!env.BASE44_TOKEN) throw new HttpError(500, 'server_not_configured');
    this.base = `${env.BASE44_API_BASE || 'https://app.base44.com'}/api/apps/${env.BASE44_APP_ID}/entities`;
    this.headers = { 'Authorization': `Bearer ${env.BASE44_TOKEN}`, 'Content-Type': 'application/json' };
  }
  async req(method, path, body) {
    const res = await fetch(this.base + path, { method, headers: this.headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      console.log('base44_error', method, path.split('?')[0], res.status, String(text).slice(0, 300));
      throw new HttpError(res.status === 429 ? 503 : 502, res.status === 429 ? 'busy' : 'database_error', { upstream: res.status });
    }
    return data;
  }
  async list(entity, q, opts = {}) {
    const items = []; let cursor = null; let guard = 0;
    do {
      const p = new URLSearchParams({ limit: String(opts.limit || 5000) });
      if (q && Object.keys(q).length) p.set('q', JSON.stringify(q));
      if (opts.sort) p.set('sort', opts.sort);
      if (cursor) p.set('cursor', cursor);
      const d = await this.req('GET', `/${entity}/v2/list?${p}`);
      items.push(...(d.items || []));
      cursor = d.has_more ? d.next_cursor : null;
    } while (cursor && ++guard < 20);
    return items;
  }
  get(entity, id) { return this.req('GET', `/${entity}/${encodeURIComponent(id)}`); }
  create(entity, data) { return this.req('POST', `/${entity}`, data); }
  update(entity, id, data) { return this.req('PUT', `/${entity}/${encodeURIComponent(id)}`, data); }
  remove(entity, id) { return this.req('DELETE', `/${entity}/${encodeURIComponent(id)}`); }
}

/* Kurzzeit-Cache pro Worker-Instanz: schont das Base44-Ratenlimit (70 Abfragen/Min). */
const cache = new Map();
async function cachedList(db, entity) {
  const hit = cache.get(entity);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.items;
  const items = await db.list(entity, null, { sort: '-created_date' });
  cache.set(entity, { ts: Date.now(), items });
  return items;
}
function invalidate(...entities) { entities.forEach(e => cache.delete(e)); }

/* ---------------- Sitzungen ---------------- */
async function requireSession(db, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new HttpError(401, 'unauthorized');
  const hash = await sha256Hex(token);
  const key = 'sess:' + hash;
  let sess = cache.get(key);
  if (!sess || Date.now() - sess.ts > 60_000) {
    const rows = await db.list('WorkshopSession', { token_hash: hash }, { limit: 1 });
    sess = { ts: Date.now(), row: rows[0] || null };
    cache.set(key, sess);
  }
  const s = sess.row;
  if (!s || new Date(s.expires_at) < new Date()) throw new HttpError(401, 'unauthorized');
  return s;
}

/* ---------------- Profilauswahl (Netflix-Stil) ----------------
 * Öffentlich mit Werkstatt-Code: nur Vorname + Initial, Rolle, Sperrstatus – keine PINs, keine IDs anderer Werkstätten.
 * Einfache Bremse gegen Durchprobieren von Codes pro IP. */
const probe = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now(); const e = probe.get(ip) || { n: 0, t: now };
  if (now - e.t > windowMs) { e.n = 0; e.t = now; }
  e.n++; probe.set(ip, e);
  if (probe.size > 5000) probe.clear();
  if (e.n > max) throw new HttpError(429, 'too_many_requests');
}
function displayName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || '?';
}
async function workshopProfiles(db, body, ip) {
  rateLimit(ip, 30, 60_000);
  const code = String(body.workshop_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw new HttpError(404, 'unknown_code');
  const [workshops, emps] = await Promise.all([cachedList(db, 'Workshop'), cachedList(db, 'Employee')]);
  const ws = workshops.find(w => w.code === code);
  const active = emps.filter(e => e.workshop_code === code && e.is_active !== false);
  if (!ws && !active.length) throw new HttpError(404, 'unknown_code');
  const order = { admin: 0, serviceberater: 1, meister: 2, mechaniker: 3 };
  return {
    workshop_code: code, workshop_name: ws ? ws.name : '',
    profiles: active.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || String(a.name).localeCompare(String(b.name), 'de'))
      .map(e => ({ id: e.id, name: displayName(e.name), role: e.role, locked: !!(e.locked_until && new Date(e.locked_until) > new Date()) })),
  };
}

/* ---------------- Login ---------------- */
async function workshopLogin(db, body) {
  const code = String(body.workshop_code || '').trim().toUpperCase();
  const name = norm(body.name);
  const empId = String(body.employee_id || '').trim();
  const pin = String(body.pin || '').trim();
  if (!code || (!name && !empId) || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'invalid');
  const emps = await db.list('Employee', { workshop_code: code });
  const active = emps.filter(e => e.is_active !== false);
  // per Profil-ID (Profilauswahl), sonst exakter Name, sonst eindeutiger Vorname
  let emp = empId ? active.find(e => e.id === empId) : active.find(e => norm(e.name) === name);
  if (!emp && !empId) {
    const byFirst = active.filter(e => norm(e.name).split(' ')[0] === name.split(' ')[0]);
    emp = byFirst.length === 1 ? byFirst[0] : null;
  }
  if (!emp) throw new HttpError(401, 'invalid');
  if (emp.locked_until && new Date(emp.locked_until) > new Date()) throw new HttpError(423, 'locked', { retry_at: emp.locked_until });
  const ok = emp.pin_salt ? safeEqual(await sha256Hex(`${emp.pin_salt}:${pin}`), String(emp.pin || '')) : false;
  if (!ok) {
    const failed = (Number(emp.failed_attempts) || 0) + 1;
    const upd = { failed_attempts: failed };
    if (failed >= MAX_FAILED) { upd.locked_until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(); upd.failed_attempts = 0; }
    await db.update('Employee', emp.id, upd);
    if (upd.locked_until) throw new HttpError(423, 'locked', { retry_at: upd.locked_until });
    throw new HttpError(401, 'invalid');
  }
  if (emp.failed_attempts || emp.locked_until) await db.update('Employee', emp.id, { failed_attempts: 0, locked_until: null });
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  await db.create('WorkshopSession', {
    token_hash: await sha256Hex(token), workshop_code: code, employee_id: emp.id, role: emp.role,
    created_at: nowIso(), expires_at: expires, last_seen_at: nowIso(),
  });
  return { token, expires_at: expires, employee: { id: emp.id, name: emp.name, role: emp.role } };
}

/* ---------------- Tablet-Daten ---------------- */
function stripOrder(o) {
  const { customer_token, ...rest } = o;
  return { ...rest, has_portal: !!customer_token };
}
function stripEmployee(e) {
  const { pin, pin_salt, failed_attempts, locked_until, ...rest } = e;
  return rest;
}
async function getTabletData(db, sess) {
  const code = sess.workshop_code;
  const lists = await Promise.all(TABLET_ENTITIES.map(e => cachedList(db, e)));
  const by = Object.fromEntries(TABLET_ENTITIES.map((e, i) => [e, lists[i]]));
  const mine = arr => arr.filter(x => x.workshop_code === code);
  const orders = mine(by.Order);
  const orderIds = new Set(orders.map(o => o.id));
  const ws = by.Workshop.find(w => w.code === code) || {};
  const [media, notes] = await Promise.all([cachedList(db, 'MediaItem').catch(() => []), cachedList(db, 'InternalNote').catch(() => [])]);
  return {
    generated_at: nowIso(),
    workshop_code: code,
    workshop: { name: ws.name || '', trial_ends_at: ws.trial_ends_at || null, subscription_status: ws.subscription_status || null },
    orders: orders.map(stripOrder),
    tasks: by.OrderTask.filter(t => t.workshop_code === code || orderIds.has(t.order_id)),
    employees: mine(by.Employee).filter(e => e.is_active !== false).map(stripEmployee),
    worktimes: mine(by.WorkTime).slice(0, 300),
    parts: [],
    lifts: mine(by.Lift),
    appointments: mine(by.Appointment),
    tire_sets: mine(by.TireSet),
    // Fotos und Sprachberichte zu Aufgaben – damit sie nach Neuladen am Tablet wieder da sind
    task_media: media.filter(m => m.workshop_code === code && orderIds.has(m.order_id) && (m.media_type === 'foto' || !m.media_type))
      .slice(0, 2000).map(m => ({ id: m.id, order_id: m.order_id, task_id: m.task_id || null, caption: m.caption || '', file_url: m.file_url, created_date: m.created_date })),
    task_notes: notes.filter(n => n.task_id && n.workshop_code === code && orderIds.has(n.order_id))
      .slice(0, 2000).map(n => ({ id: n.id, order_id: n.order_id, task_id: n.task_id, content: n.content || '', created_date: n.created_date })),
    backend: 'worker',
  };
}

/* ---------------- Tablet-Aktionen ---------------- */
const NOT_AVAILABLE = ['alex_execute'];
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
function decodeDataUrl(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'invalid_image');
  const bin = atob(m[3].replace(/\s+/g, ''));
  if (bin.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'too_large');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType: m[1], ext: m[2] === 'jpeg' ? 'jpg' : m[2] };
}
/* ---- Chat-Anhänge (Fotos + PDF) im Foto-Speicher (KV) ---- */
const FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const ATTACH_MARK = '📎 Anhang';
function cleanFileName(n, ext) {
  let s = String(n || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!s) s = ext === 'pdf' ? 'Dokument.pdf' : 'Foto.' + ext;
  return s;
}
async function storeAttachment(env, origin, code, dataUrl, name) {
  if (!env.PHOTOS) throw new HttpError(503, 'not_available', { message: 'Datei-Speicher ist noch nicht eingerichtet.' });
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m || !FILE_TYPES[m[1]]) throw new HttpError(400, 'invalid_file', { message: 'Nur Fotos (JPG, PNG, WebP) und PDF-Dateien sind erlaubt.' });
  const bin = atob(m[2].replace(/\s+/g, ''));
  if (bin.length > MAX_FILE_BYTES) throw new HttpError(413, 'too_large', { message: 'Datei ist zu groß (max. 6 MB).' });
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (m[1] === 'application/pdf' && !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new HttpError(400, 'invalid_file', { message: 'Die Datei ist kein gültiges PDF.' });
  const ext = FILE_TYPES[m[1]];
  const fileName = cleanFileName(name, ext);
  const key = `${String(code || 'SUPPORT').toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'SUPPORT'}/chat/${randomHex(16)}.${ext}`;
  await env.PHOTOS.put(key, bytes, { metadata: { contentType: m[1], name: fileName, uploaded_at: nowIso() } });
  return { url: `${origin}/photo/${key}`, name: fileName, type: m[1], size: bytes.length };
}
// Nur Anhänge aus dem eigenen Speicher und der eigenen Werkstatt übernehmen
function cleanAttachments(list, origin, code) {
  if (!Array.isArray(list)) return [];
  const prefix = `${origin}/photo/${String(code || 'SUPPORT').toUpperCase()}/chat/`;
  return list.slice(0, 5).filter(a => a && typeof a.url === 'string' && a.url.startsWith(prefix) && /\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/.test(a.url))
    .map(a => ({ url: a.url, name: String(a.name || '').slice(0, 100), type: Object.keys(FILE_TYPES).includes(a.type) ? a.type : (a.url.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg'), size: Number(a.size) || 0 }));
}
async function ownRecord(db, entity, id, code) {
  if (!id) throw new HttpError(400, 'params');
  let rec;
  try { rec = await db.get(entity, id); } catch (e) { if (e.extra && e.extra.upstream === 404) throw new HttpError(404, 'not_found'); throw e; }
  if (!rec || rec.workshop_code !== code) throw new HttpError(404, 'not_found');
  return rec;
}
async function employeeOf(db, sess) {
  const key = 'emp:' + sess.employee_id;
  const c = cache.get(key);
  if (c && Date.now() - c.ts < 300_000) return c.row;
  const row = await db.get('Employee', sess.employee_id).catch(() => null);
  cache.set(key, { ts: Date.now(), row });
  return row || { name: 'Tablet', role: sess.role };
}
/* ---- Gespeicherter Reifenscan ---- */
const TIRE_SLOT_KEYS = ['flanke', 'laufflaeche', 'felge'];
const TIRE_SLOT_BY_LABEL = { 'flanke': 'flanke', 'lauffläche': 'laufflaeche', 'felge': 'felge' };
const tireKey = (code, orderId) => `_tirescan/${code}/${orderId}`;
const utcMs = d => { if (!d) return 0; const s = String(d); return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z') || 0; };
const tf = v => ({ value: v === undefined ? null : v, confidence: 1, manual: true });
// Befund-Notiz („Reifenscan (KI) – …“) zurück in Felder übersetzen – für Scans, die vor der strukturierten Ablage gespeichert wurden
function parseTireNote(text) {
  const lines = String(text || '').split('\n').map(l => l.trim());
  const head = lines[0] || '';
  const r = {}; ['brand', 'model', 'size', 'load_index', 'speed_index', 'season', 'dot_code', 'production_week', 'production_year', 'tire_age_years', 'tread_depth_mm', 'overall_condition'].forEach(k => { r[k] = tf(null); });
  r.tire_damages = []; r.rim_damages = []; r.mech_notes = '';
  r.manual = /^Reifendaten/.test(head);
  if (/korrigiert/.test(head)) r.edited = true;
  const num = s => { const n = Number(String(s).replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const dmg = s => (!s || /^keine erkannt$/i.test(s.trim())) ? [] : s.split(/;\s*/).map(x => x.trim()).filter(Boolean);
  for (const l of lines.slice(1)) {
    let m;
    if ((m = /^Reifen:\s*(.*)$/.exec(l))) {
      let rest = m[1];
      const sm = /,?\s*Saison\s+(\S+)\s*$/.exec(rest);
      if (sm) { r.season = tf(sm[1].toLowerCase()); rest = rest.slice(0, sm.index); }
      const zm = /(\d{3}\/\d{2}\s*Z?R\s*\d{2}(?:[.,]\d)?)(?:\s+(?:(\d{2,3})|–)?([A-Z]{1,2})?)?/.exec(rest);
      if (zm) {
        r.size = tf(zm[1].replace(/\s+/g, ' '));
        if (zm[2]) r.load_index = tf(parseInt(zm[2], 10));
        if (zm[3]) r.speed_index = tf(zm[3]);
        rest = rest.slice(0, zm.index);
      }
      const bm = rest.replace(/,\s*$/, '').trim();
      if (bm) { const p = bm.split(/\s+/); r.brand = tf(p[0]); if (p.length > 1) r.model = tf(p.slice(1).join(' ')); }
    } else if (/^(DOT\b|Profil\b|Zustand\b|ca\.)/.test(l)) {
      if ((m = /DOT\s+(\d{3,4})/.exec(l))) {
        r.dot_code = tf(m[1]);
        const d = /(\d{2})(\d{2})$/.exec(m[1]);
        if (d && +d[1] >= 1 && +d[1] <= 53) { r.production_week = tf(+d[1]); r.production_year = tf(2000 + +d[2]); }
      }
      if ((m = /ca\.\s*([\d.,]+)\s*Jahre/.exec(l))) r.tire_age_years = tf(num(m[1]));
      if ((m = /Profil\s+([\d.,]+)\s*mm/.exec(l))) r.tread_depth_mm = tf(num(m[1]));
      if ((m = /Zustand\s+([^\s,]+)/.exec(l)) && m[1] !== '–') r.overall_condition = tf(m[1]);
    } else if ((m = /^Schäden Reifen:\s*(.*)$/.exec(l))) r.tire_damages = dmg(m[1]);
    else if ((m = /^Schäden Felge:\s*(.*)$/.exec(l))) r.rim_damages = dmg(m[1]);
    else if ((m = /^Schäden\/Bemerkungen Mechaniker:\s*(.*)$/.exec(l))) r.mech_notes = m[1].split(/;\s*/).join('\n');
  }
  return r;
}
async function loadSavedTireScan(db, env, code, orderId) {
  const [stored, notes, media] = await Promise.all([
    env.PHOTOS ? env.PHOTOS.get(tireKey(code, orderId), { type: 'json' }).catch(() => null) : null,
    db.list('InternalNote', { order_id: orderId }, { sort: '-created_date' }).catch(() => []),
    db.list('MediaItem', { order_id: orderId }, { sort: '-created_date' }).catch(() => []),
  ]);
  const note = notes.filter(n => n.workshop_code === code && /^(Reifenscan|Reifendaten) \(/.test(String(n.content || '')))
    .sort((a, b) => utcMs(b.created_date) - utcMs(a.created_date))[0];
  // Strukturierte Ablage gewinnt, außer es gibt eine deutlich neuere Befund-Notiz (z. B. aus einem anderen Weg)
  if (stored && stored.result && !(note && utcMs(note.created_date) > utcMs(stored.saved_at) + 60_000)) {
    return { result: stored.result, photos: stored.photos || {}, saved_at: stored.saved_at, saved_by: stored.saved_by || '' };
  }
  const photos = {};
  media.filter(m => m.workshop_code === code && /^Reifenscan – /.test(String(m.caption || '')))
    .sort((a, b) => utcMs(b.created_date) - utcMs(a.created_date))
    .forEach(m => { const slot = TIRE_SLOT_BY_LABEL[String(m.caption).slice('Reifenscan – '.length).trim().toLowerCase()]; if (slot && !photos[slot]) photos[slot] = m.file_url; });
  if (!note && !Object.keys(photos).length) return null;
  return { result: note ? parseTireNote(note.content) : null, photos, saved_at: note ? new Date(utcMs(note.created_date)).toISOString() : null, saved_by: note ? (note.author_name || '') : '', from_note: !!note };
}

async function tabletAction(db, sess, body, env, origin, ctx) {
  const action = body.action;
  const code = sess.workshop_code;
  if (NOT_AVAILABLE.includes(action)) throw new HttpError(503, 'not_available', { message: 'Diese Funktion ist auf dem eigenen Server noch nicht eingerichtet.' });
  const emp = await employeeOf(db, sess);

  if (action === 'alex_ask') {
    const [tablet, inventory] = await Promise.all([getTabletData(db, sess), cachedList(db, 'InventoryItem')]);
    return alexAsk(db, sess, body, env, { ...tablet, inventory: inventory.filter(i => i.workshop_code === code) });
  }
  if (action === 'tire_scan') {
    if (body.order_id) await ownRecord(db, 'Order', body.order_id, code);
    return tireScan(sess, body, env, decodeDataUrl);
  }
  // Zuletzt gespeicherten Reifenscan eines Auftrags laden (Tablet zeigt ihn nach Neuladen wieder an)
  if (action === 'tire_scan_get') {
    const order = await ownRecord(db, 'Order', body.order_id, code);
    return { ok: true, saved: await loadSavedTireScan(db, env, code, order.id) };
  }
  // Strukturierte Kopie des Befunds (Felder + Foto-Adressen) zusätzlich zur Notiz ablegen
  if (action === 'tire_scan_store') {
    const order = await ownRecord(db, 'Order', body.order_id, code);
    if (!env.PHOTOS) return { ok: true, stored: false };
    const raw = JSON.stringify(body.result || null);
    if (!body.result || typeof body.result !== 'object' || raw.length > 30000) throw new HttpError(400, 'params');
    const prefix = `${origin}/photo/${code}/${order.id}/`;
    const photos = {};
    for (const s of TIRE_SLOT_KEYS) {
      const u = body.photos && body.photos[s];
      if (typeof u === 'string' && u.startsWith(prefix) && /\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(u)) photos[s] = u;
    }
    await env.PHOTOS.put(tireKey(code, order.id), JSON.stringify({ result: JSON.parse(raw), photos, saved_at: nowIso(), saved_by: emp.name }));
    return { ok: true, stored: true };
  }

  if (action === 'media_upload') {
    if (!env.PHOTOS) throw new HttpError(503, 'not_available', { message: 'Foto-Speicher ist noch nicht eingerichtet.' });
    const order = await ownRecord(db, 'Order', body.order_id, code);
    const { bytes, contentType, ext } = decodeDataUrl(body.data_url);
    const key = `${code}/${order.id}/${randomHex(16)}.${ext}`;
    await env.PHOTOS.put(key, bytes, { metadata: { contentType, uploaded_by: emp.name, uploaded_at: nowIso() } });
    const fileUrl = `${origin}/photo/${key}`;
    const media = await db.create('MediaItem', {
      file_url: fileUrl, media_type: 'foto', order_id: order.id, workshop_code: code,
      caption: String(body.caption || '').slice(0, 200), uploaded_by_name: emp.name,
      ...(body.task_id ? { task_id: String(body.task_id).slice(0, 64) } : {}),
    });
    invalidate('MediaItem');
    if (body.set_as_vehicle_photo) { await db.update('Order', order.id, { vehicle_photo: fileUrl }); invalidate('Order'); }
    return { ok: true, file_url: fileUrl, media_id: media.id };
  }

  if (action === 'task_update') {
    const task = await db.get('OrderTask', body.task_id).catch(() => null);
    if (!task) throw new HttpError(404, 'not_found');
    if (task.workshop_code !== code) await ownRecord(db, 'Order', task.order_id, code);
    const status = ['offen', 'in_arbeit', 'erledigt'].includes(body.status) ? body.status : null;
    if (!status) throw new HttpError(400, 'params');
    const upd = { status };
    if (status === 'erledigt') { upd.completed_by = emp.name; upd.completed_date = nowIso(); }
    await db.update('OrderTask', task.id, upd);
    invalidate('OrderTask');
    // Erste Aufgabe begonnen/erledigt → Auftrag von „Fahrzeug angenommen“ auf „Reparatur läuft“ (sichtbar in Base44 + Kundenportal)
    let orderStatus = null;
    if (status !== 'offen' && task.order_id) {
      const order = await db.get('Order', task.order_id).catch(() => null);
      if (order && order.workshop_code === code && order.status === 'fahrzeug_angenommen') {
        await db.update('Order', order.id, { status: 'reparatur_laeuft' });
        invalidate('Order'); orderStatus = 'reparatur_laeuft';
      }
    }
    return { ok: true, order_status: orderStatus };
  }
  if (action === 'worktime_start') {
    if (body.order_id) await ownRecord(db, 'Order', body.order_id, code);
    const wt = await db.create('WorkTime', {
      employee_name: emp.name, order_id: body.order_id || null, description: String(body.description || '').slice(0, 300),
      start_timestamp: nowIso(), workshop_code: code,
    });
    invalidate('WorkTime');
    return { ok: true, worktime_id: wt.id };
  }
  if (action === 'worktime_stop') {
    const wt = await ownRecord(db, 'WorkTime', body.worktime_id, code);
    if (wt.end_timestamp) return { ok: true };
    const end = new Date();
    const minutes = Math.min(WORKTIME_CAP_MIN, Math.max(0, Math.round((end - new Date(wt.start_timestamp)) / 60000)));
    await db.update('WorkTime', wt.id, { end_timestamp: end.toISOString(), duration_minutes: minutes });
    invalidate('WorkTime');
    return { ok: true, duration_minutes: minutes };
  }
  if (action === 'note_add') {
    const content = String(body.content || '').trim().slice(0, 5000);
    if (!content) throw new HttpError(400, 'params');
    await ownRecord(db, 'Order', body.order_id, code);
    await db.create('InternalNote', { order_id: body.order_id, content, author_name: emp.name, author_role: ['admin', 'serviceberater', 'mechaniker'].includes(emp.role) ? emp.role : 'mechaniker', workshop_code: code, ...(body.task_id ? { task_id: String(body.task_id).slice(0, 64) } : {}) });
    invalidate('InternalNote');
    return { ok: true };
  }
  // Qualitätskontrolle: jeder Haken wird sofort am Auftrag gespeichert (überlebt Neuladen/Gerätewechsel)
  if (action === 'qc_save') {
    const order = await ownRecord(db, 'Order', body.order_id, code);
    if (!Array.isArray(body.qc) || !body.qc.length || body.qc.length > 50) throw new HttpError(400, 'params');
    const prev = Array.isArray(order.qc_checklist) ? order.qc_checklist : [];
    const qc = body.qc.map(q => {
      const label = String((q && q.label) || '').slice(0, 200);
      const checked = !!(q && q.checked);
      const old = prev.find(p => p.label === label);
      // Wer/wann nur ändern, wenn sich der Haken wirklich ändert
      if (old && !!old.checked === checked) return { label, checked, by: old.by || '', at: old.at || '' };
      return { label, checked, by: checked ? emp.name : '', at: checked ? nowIso() : '' };
    });
    await db.update('Order', order.id, { qc_checklist: qc });
    invalidate('Order');
    return { ok: true, qc };
  }
  if (action === 'order_complete') {
    const order = await ownRecord(db, 'Order', body.order_id, code);
    const qc = Array.isArray(body.qc) ? body.qc.slice(0, 50) : [];
    const lines = qc.map(q => `${q.checked ? '✓' : '✗'} ${String(q.label || '').slice(0, 200)}`);
    await db.create('WorkshopLog', {
      title: 'Qualitätsprüfung & Fertigmeldung', log_type: 'qualitaet',
      description: lines.length ? lines.join('\n') : 'Auftrag am Tablet abgeschlossen.',
      related_order_id: order.id, employee_name: emp.name, log_date: nowIso(),
      vehicle_info: [order.vehicle_brand, order.vehicle_model, order.license_plate].filter(Boolean).join(' '), workshop_code: code,
    });
    const tasks = (await cachedList(db, 'OrderTask')).filter(t => t.order_id === order.id && t.status !== 'erledigt');
    for (const t of tasks) await db.update('OrderTask', t.id, { status: 'erledigt', completed_by: emp.name, completed_date: nowIso() });
    await db.update('Order', order.id, { status: 'abholbereit' });
    invalidate('Order', 'OrderTask');
    if (body.notify_customer !== false && ctx) ctx.waitUntil(mailReady(env, db, order).catch(e => console.log('mail', String(e))));
    return { ok: true, email_queued: !!(env.RESEND_API_KEY && order.email) };
  }
  if (action === 'send_portal_link') {
    if (!['admin', 'serviceberater'].includes(sess.role)) throw new HttpError(403, 'forbidden');
    const order = await ownRecord(db, 'Order', body.order_id, code);
    if (!order.customer_token) throw new HttpError(400, 'no_portal');
    if (!order.email) throw new HttpError(400, 'no_email');
    if (!env.RESEND_API_KEY) throw new HttpError(503, 'not_available', { message: 'E-Mail-Versand ist noch nicht eingerichtet.' });
    const r = await mailPortalLink(env, db, order);
    if (!r.sent) throw new HttpError(502, 'mail_failed');
    return { ok: true, sent_to: order.email.replace(/^(.).*(@.*)$/, '$1…$2') };
  }
  if (action === 'tire_update') {
    const tire = await ownRecord(db, 'TireSet', body.id, code);
    const allowed = ['tread_depth', 'condition', 'season', 'storage_location', 'storage_hall', 'storage_rack', 'storage_level', 'storage_compartment'];
    const upd = {};
    allowed.forEach(k => { if (body[k] !== undefined) upd[k] = body[k]; });
    if (upd.season && !['sommer', 'winter', 'ganzjahr'].includes(upd.season)) throw new HttpError(400, 'invalid_season');
    if (upd.condition && !['neu', 'gut', 'mittel', 'abgefahren'].includes(upd.condition)) throw new HttpError(400, 'invalid_condition');
    if (upd.tread_depth !== undefined) { upd.tread_depth = Number(upd.tread_depth); if (!(upd.tread_depth >= 0 && upd.tread_depth <= 12)) throw new HttpError(400, 'params'); }
    if (!Object.keys(upd).length) throw new HttpError(400, 'params');
    await db.update('TireSet', tire.id, upd);
    invalidate('TireSet');
    return { ok: true };
  }
  throw new HttpError(400, 'unknown_action');
}

/* ---------------- Kundenportal ---------------- */
async function portalOrder(db, token) {
  token = String(token || '').trim();
  if (token.length < 6 || token.length > 128) throw new HttpError(404, 'not_found');
  const rows = await db.list('Order', { customer_token: token }, { limit: 1 });
  if (!rows[0]) throw new HttpError(404, 'not_found');
  return rows[0];
}
async function portalApi(db, body, env, ctx, origin) {
  const order = await portalOrder(db, body.token);
  const code = order.workshop_code;
  const action = body.action || 'get';

  if (action === 'get') {
    const [approvals, media, apptsByOrder, apptsByToken, services, logs, profiles, messages] = await Promise.all([
      db.list('ApprovalRequest', { order_id: order.id }),
      db.list('MediaItem', { order_id: order.id }),
      db.list('Appointment', { order_id: order.id }),
      db.list('Appointment', { customer_token: order.customer_token }),
      cachedList(db, 'Service'),
      db.list('WorkshopLog', { related_order_id: order.id }),
      cachedList(db, 'WorkshopProfile'),
      db.list('OrderMessage', { order_id: order.id }).catch(() => []),
    ]);
    // Nachrichten der Werkstatt als vom Kunden gelesen markieren (im Hintergrund)
    const unreadForCustomer = messages.filter(m => m.sender === 'werkstatt' && !m.read_by_customer).slice(0, 20);
    if (unreadForCustomer.length && ctx) ctx.waitUntil(Promise.all(unreadForCustomer.map(m => db.update('OrderMessage', m.id, { read_by_customer: true }).catch(() => {}))));
    const appts = [...new Map([...apptsByOrder, ...apptsByToken].map(a => [a.id, a])).values()]
      .sort((a, b) => String(a.appointment_date + a.time_slot).localeCompare(String(b.appointment_date + b.time_slot)));
    const prof = profiles.find(p => p.workshop_code === code) || {};
    const { customer_token, billing_street, billing_zip, billing_city, ...pubOrder } = order;
    return {
      order: pubOrder,
      approvals,
      media: media.filter(m => m.media_type === 'foto' || !m.media_type).map(m => ({ id: m.id, file_url: m.file_url, caption: m.caption, created_date: m.created_date })),
      appointments: appts.map(({ customer_token: _t, owner_user_id, ...a }) => a),
      services: services.filter(s => s.is_active !== false && (!s.workshop_code || s.workshop_code === code))
        .map(s => ({ id: s.id, name: s.name, category: s.category, description: s.description, estimated_duration_minutes: s.estimated_duration_minutes, base_price: s.base_price, price_range_min: s.price_range_min, price_range_max: s.price_range_max, is_active: s.is_active, workshop_code: s.workshop_code })),
      workshop_logs: logs.map(l => ({ id: l.id, title: l.title, log_type: l.log_type, description: l.description, log_date: l.log_date, employee_name: l.employee_name })),
      workshop: { name: prof.company_name || '', phone: prof.phone || '', email: prof.email || '', address: [prof.address_street, [prof.address_zip, prof.address_city].filter(Boolean).join(' ')].filter(Boolean).join(', ') },
      messages: messages.map(m => ({ id: m.id, sender: m.sender, sender_name: m.sender === 'kunde' ? '' : (m.sender_name || prof.company_name || 'Werkstatt'), content: m.content, attachments: Array.isArray(m.attachments) ? m.attachments : [], created_date: m.created_date }))
        .sort((a, b) => String(a.created_date).localeCompare(String(b.created_date))),
    };
  }
  if (action === 'respond') {
    const decision = body.decision;
    if (!['freigegeben', 'abgelehnt', 'rueckruf_angefordert'].includes(decision)) throw new HttpError(400, 'params');
    const ap = await db.get('ApprovalRequest', body.approval_id).catch(() => null);
    if (!ap || ap.order_id !== order.id) throw new HttpError(404, 'not_found');
    if (ap.status !== 'ausstehend' && ap.status !== 'rueckruf_angefordert') throw new HttpError(409, 'already_answered');
    await db.update('ApprovalRequest', ap.id, { status: decision, customer_response_date: nowIso() });
    if (ctx) ctx.waitUntil(mailApprovalAnswer(env, db, order, ap, decision).catch(e => console.log('mail', String(e))));
    return { ok: true };
  }
  if (action === 'book') {
    const a = body.appointment || {};
    const date = String(a.appointment_date || '').slice(0, 10);
    const slot = String(a.time_slot || '').slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !TIME_SLOTS.includes(slot)) throw new HttpError(400, 'invalid_slot');
    const today = berlinToday();
    const dow = new Date(date + 'T12:00:00Z').getUTCDay();
    const [h, m] = slot.split(':').map(Number);
    if (dow === 0 || date < today || (date === today && h * 60 + m - berlinNowMinutes() < 60)) throw new HttpError(400, 'invalid_slot');
    const maxDate = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
    if (date > maxDate) throw new HttpError(400, 'invalid_slot');
    const sameDay = await db.list('Appointment', { workshop_code: code, appointment_date: date });
    if (sameDay.some(x => x.status !== 'storniert' && String(x.time_slot).slice(0, 5) === slot)) throw new HttpError(409, 'slot_taken');
    let service = null;
    if (a.service_id) {
      service = (await cachedList(db, 'Service')).find(s => s.id === a.service_id && (!s.workshop_code || s.workshop_code === code)) || null;
    }
    const type = ['fahrzeugabgabe', 'reifenwechsel', 'inspektion', 'sonstiges'].includes(a.appointment_type) ? a.appointment_type : 'sonstiges';
    const created = await db.create('Appointment', {
      order_id: order.id, workshop_code: code, customer_token: order.customer_token,
      customer_name: order.customer_name, phone: order.phone || '', email: order.email || '',
      vehicle_brand: order.vehicle_brand, vehicle_model: order.vehicle_model, license_plate: order.license_plate,
      appointment_type: type, service_id: service ? service.id : null, service_name: service ? service.name : null,
      estimated_duration: service ? service.estimated_duration_minutes || 30 : 30,
      appointment_date: date, time_slot: slot, status: 'offen',
      notification_channel: 'email', notification_sent: false, notes: 'Online gebucht (Kundenportal)',
    });
    invalidate('Appointment');
    if (ctx) ctx.waitUntil(mailBooking(env, db, order, created).catch(e => console.log('mail', String(e))));
    const { customer_token: _ct, owner_user_id: _ou, ...pubAppt } = created;
    return { ok: true, appointment_id: created.id, appointment: pubAppt };
  }
  if (action === 'attachment_upload') {
    rateLimit('portalfile:' + order.id, 30, 3600_000);
    return { ok: true, attachment: await storeAttachment(env, origin, code, body.data_url, body.name) };
  }
  if (action === 'message_send') {
    const attachments = cleanAttachments(body.attachments, origin, code);
    const content = String(body.content || '').trim().slice(0, 2000) || (attachments.length ? ATTACH_MARK : '');
    if (!content) throw new HttpError(400, 'params');
    rateLimit('portalmsg:' + order.id, 30, 3600_000);
    const created = await db.create('OrderMessage', {
      order_id: order.id, workshop_code: code, sender: 'kunde', sender_name: order.customer_name || 'Kunde',
      content, attachments, read_by_customer: true, read_by_workshop: false,
    });
    if (ctx) ctx.waitUntil(mailCustomerMessage(env, db, order, content, attachments).catch(e => console.log('mail', String(e))));
    return { ok: true, message: { id: created.id, sender: 'kunde', content, attachments, created_date: created.created_date || nowIso() } };
  }
  if (action === 'cancel') {
    const ap = await db.get('Appointment', body.appointment_id).catch(() => null);
    if (!ap || (ap.order_id !== order.id && ap.customer_token !== order.customer_token)) throw new HttpError(404, 'not_found');
    if (String(ap.appointment_date).slice(0, 10) < berlinToday()) throw new HttpError(400, 'past');
    await db.update('Appointment', ap.id, { status: 'storniert' });
    invalidate('Appointment');
    return { ok: true };
  }
  throw new HttpError(400, 'unknown_action');
}


/* ---------------- E-Mails (Resend) ----------------
 * Secret RESEND_API_KEY + Variable MAIL_FROM (z. B. "AutoLeitwerk <noreply@autoleitwerk.de>").
 * Ohne Schlüssel wird nichts verschickt – die Aktionen funktionieren trotzdem. */
const PORTAL_BASE = 'https://kabarabusiness-creator.github.io/werkstattflow-pilot/kundenapp.html';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mailHtml({ title, intro, rows = [], button, footer }) {
  return `<!doctype html><html lang="de"><body style="margin:0;background:#f4f4f7;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1a1a2e">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#1a1a2e;padding:18px 24px;color:#fff;font-weight:700;font-style:italic;letter-spacing:.5px"><span style="color:#a78bfa">AUTO</span>LEITWERK</td></tr>
<tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 10px">${esc(title)}</h1>
<p style="font-size:15px;line-height:1.55;margin:0 0 16px">${intro}</p>
${rows.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6fb;border-radius:10px;padding:12px 14px;margin-bottom:18px">${rows.map(([k, v]) => `<tr><td style="font-size:13px;color:#6b6b88;padding:3px 0">${esc(k)}</td><td style="font-size:14px;font-weight:600;text-align:right;padding:3px 0">${esc(v)}</td></tr>`).join('')}</table>` : ''}
${button ? `<a href="${esc(button.href)}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${esc(button.label)}</a>` : ''}
<p style="font-size:12.5px;color:#6b6b88;line-height:1.5;margin:22px 0 0">${footer || ''}</p>
</td></tr></table>
<p style="font-size:11px;color:#8a8aa8;margin-top:14px">Gesendet über AutoLeitwerk · <a href="https://kabarabusiness-creator.github.io/werkstattflow-pilot/datenschutz.html" style="color:#8a8aa8">Datenschutz</a></p>
</td></tr></table></body></html>`;
}
async function workshopInfo(db, code) {
  const [profiles, workshops] = await Promise.all([cachedList(db, 'WorkshopProfile'), cachedList(db, 'Workshop')]);
  const p = profiles.find(x => x.workshop_code === code) || {};
  const w = workshops.find(x => x.code === code) || {};
  return { name: p.company_name || w.name || 'Ihre Werkstatt', phone: p.phone || '', email: p.email || '',
    address: [p.address_street, [p.address_zip, p.address_city].filter(Boolean).join(' ')].filter(Boolean).join(', ') };
}
function contactFooter(ws) {
  return `${esc(ws.name)}${ws.address ? ' · ' + esc(ws.address) : ''}${ws.phone ? '<br>Telefon: ' + esc(ws.phone) : ''}${ws.email ? ' · ' + esc(ws.email) : ''}`;
}
async function sendMail(env, db, { to, subject, html, replyTo, orderId, code, statusText }) {
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''));
  if (!env.RESEND_API_KEY || !valid) return { sent: false, reason: !env.RESEND_API_KEY ? 'not_configured' : 'no_email' };
  let state = 'gesendet', reason = null;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'AutoLeitwerk <noreply@autoleitwerk.de>', to: [to], subject, html, reply_to: replyTo || undefined }),
    });
    if (!res.ok) { state = 'fehlgeschlagen'; reason = `${res.status} ${(await res.text()).slice(0, 200)}`; console.log('mail_error', reason); }
  } catch (e) { state = 'fehlgeschlagen'; reason = String(e); }
  if (orderId && db) {
    await db.create('Notification', { order_id: orderId, channel: 'email', subject, body: subject, recipient: to, status_text: statusText || '', delivery_state: state, workshop_code: code }).catch(() => {});
  }
  return { sent: state === 'gesendet', reason };
}
const portalLink = o => `${PORTAL_BASE}?token=${encodeURIComponent(o.customer_token || '')}`;
const fmtDate = d => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}.${m}.${y}`; };
async function mailPortalLink(env, db, order) {
  const ws = await workshopInfo(db, order.workshop_code);
  return sendMail(env, db, {
    to: order.email, replyTo: ws.email, orderId: order.id, code: order.workshop_code, statusText: 'Portal-Link',
    subject: `Ihr Fahrzeug bei ${ws.name} – Status online verfolgen`,
    html: mailHtml({ title: `Hallo ${order.customer_name || ''},`, intro: `Ihr Fahrzeug ist bei <b>${esc(ws.name)}</b> angenommen. Über Ihr persönliches Kundenportal sehen Sie jederzeit den aktuellen Stand, können Zusatzarbeiten freigeben und Termine buchen.`,
      rows: [['Fahrzeug', [order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ')], ['Kennzeichen', order.license_plate || '–'], ['Auftrag', '#' + (order.order_number || '')]],
      button: { label: 'Kundenportal öffnen', href: portalLink(order) }, footer: contactFooter(ws) + '<br>Den Link bitte nicht weitergeben – er gilt nur für Ihren Auftrag.' }),
  });
}
async function mailReady(env, db, order) {
  const ws = await workshopInfo(db, order.workshop_code);
  return sendMail(env, db, {
    to: order.email, replyTo: ws.email, orderId: order.id, code: order.workshop_code, statusText: 'Abholbereit',
    subject: `Ihr ${[order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ') || 'Fahrzeug'} ist abholbereit`,
    html: mailHtml({ title: 'Ihr Fahrzeug ist fertig! 🎉', intro: `Gute Nachricht: Die Arbeiten an Ihrem Fahrzeug sind abgeschlossen und geprüft. Sie können es bei <b>${esc(ws.name)}</b> abholen.`,
      rows: [['Kennzeichen', order.license_plate || '–'], ['Auftrag', '#' + (order.order_number || '')]],
      button: order.customer_token ? { label: 'Details im Kundenportal', href: portalLink(order) } : null, footer: contactFooter(ws) }),
  });
}
async function mailBooking(env, db, order, appt) {
  const ws = await workshopInfo(db, order.workshop_code);
  const rows = [['Datum', fmtDate(appt.appointment_date)], ['Uhrzeit', appt.time_slot + ' Uhr'], ['Anliegen', appt.service_name || appt.appointment_type], ['Fahrzeug', order.license_plate || '–']];
  const r = await sendMail(env, db, {
    to: order.email, replyTo: ws.email, orderId: order.id, code: order.workshop_code, statusText: 'Termin angefragt',
    subject: `Terminanfrage bei ${ws.name}: ${fmtDate(appt.appointment_date)}, ${appt.time_slot} Uhr`,
    html: mailHtml({ title: 'Ihre Terminanfrage ist eingegangen', intro: `Vielen Dank! Ihr Wunschtermin ist bei <b>${esc(ws.name)}</b> eingegangen. Die Werkstatt bestätigt ihn in Kürze.`, rows,
      button: { label: 'Termin im Kundenportal ansehen', href: portalLink(order) }, footer: contactFooter(ws) + '<br>Absagen können Sie den Termin jederzeit im Kundenportal.' }),
  });
  if (ws.email) await sendMail(env, db, { to: ws.email, subject: `Neue Online-Terminanfrage: ${order.customer_name} · ${fmtDate(appt.appointment_date)} ${appt.time_slot}`,
    html: mailHtml({ title: 'Neue Terminanfrage', intro: `${esc(order.customer_name)} hat über das Kundenportal einen Termin angefragt.`, rows: [...rows, ['Kunde', order.customer_name], ['Telefon', order.phone || '–']], footer: 'Bitte im Dashboard bestätigen.' }) });
  return r;
}
async function mailApprovalAnswer(env, db, order, ap, decision) {
  const ws = await workshopInfo(db, order.workshop_code);
  if (!ws.email) return { sent: false, reason: 'no_email' };
  const label = { freigegeben: '✅ freigegeben', abgelehnt: '❌ abgelehnt', rueckruf_angefordert: '📞 Rückruf gewünscht' }[decision] || decision;
  return sendMail(env, db, { to: ws.email, subject: `Freigabe ${label}: ${ap.title || 'Zusatzarbeit'} · ${order.license_plate || ''}`,
    html: mailHtml({ title: `Kunde hat geantwortet: ${label}`, intro: `${esc(order.customer_name)} hat auf die Zusatzarbeit geantwortet.`,
      rows: [['Arbeit', ap.title || '–'], ['Kosten', ap.additional_cost != null ? `${Number(ap.additional_cost).toLocaleString('de-DE')} €` : '–'], ['Kennzeichen', order.license_plate || '–'], ['Telefon', order.phone || '–']] }) });
}

/* ---------------- Nachrichten & Live-Chat ---------------- */
const DASHBOARD_URL = 'https://autoleitwerk.base44.app';
const SUPPORT_TO = env => env.SUPPORT_EMAIL || 'info@autoleitwerk.de';
const notifyThrottle = new Map();
// höchstens eine Benachrichtigung pro Gesprächsrichtung in `ms` (verhindert Mail-Flut bei vielen kurzen Nachrichten)
function throttled(key, ms) {
  const now = Date.now(); const last = notifyThrottle.get(key) || 0;
  if (now - last < ms) return true;
  notifyThrottle.set(key, now);
  if (notifyThrottle.size > 5000) notifyThrottle.clear();
  return false;
}
const quote = (t, atts) => {
  const text = String(t || '') === ATTACH_MARK && atts && atts.length ? '' : String(t || '').slice(0, 1500);
  const files = (atts || []).map(a => `<div style="margin-top:6px">📎 <a href="${esc(a.url)}" style="color:#7c3aed">${esc(a.name || 'Anhang')}</a></div>`).join('');
  return `<div style="white-space:pre-wrap;background:#f7f6fb;border-left:3px solid #7c3aed;border-radius:8px;padding:10px 12px;margin:0 0 16px;font-size:14.5px;line-height:1.5">${esc(text)}${files}</div>`;
};
async function mailCustomerMessage(env, db, order, content, atts) {
  const ws = await workshopInfo(db, order.workshop_code);
  if (!ws.email || throttled('kunde>ws:' + order.id, 10 * 60_000)) return { sent: false };
  return sendMail(env, db, { to: ws.email, replyTo: order.email || undefined, orderId: order.id, code: order.workshop_code, statusText: 'Kundennachricht',
    subject: `Neue Kundennachricht: ${order.customer_name || 'Kunde'} · ${order.license_plate || ''}`,
    html: mailHtml({ title: 'Neue Nachricht im Kundenportal', intro: `<b>${esc(order.customer_name || 'Ein Kunde')}</b> hat Ihnen geschrieben:</p>${quote(content, atts)}<p style="font-size:13px;color:#6b6b88;margin:0 0 16px">`,
      rows: [['Fahrzeug', [order.vehicle_brand, order.vehicle_model].filter(Boolean).join(' ') || '–'], ['Kennzeichen', order.license_plate || '–'], ['Auftrag', '#' + (order.order_number || '')]],
      button: { label: 'Im Dashboard antworten', href: `${DASHBOARD_URL}/live-chat?tab=kunden&order=${encodeURIComponent(order.id)}` } }) });
}
async function mailWorkshopMessage(env, db, order, content, atts) {
  if (!order.email || throttled('ws>kunde:' + order.id, 10 * 60_000)) return { sent: false };
  const ws = await workshopInfo(db, order.workshop_code);
  return sendMail(env, db, { to: order.email, replyTo: ws.email, orderId: order.id, code: order.workshop_code, statusText: 'Nachricht an Kunden',
    subject: `Neue Nachricht von ${ws.name}`,
    html: mailHtml({ title: `Hallo ${order.customer_name || ''},`, intro: `<b>${esc(ws.name)}</b> hat Ihnen zu Ihrem Fahrzeug ${esc(order.license_plate || '')} geschrieben:</p>${quote(content, atts)}<p style="font-size:13px;color:#6b6b88;margin:0 0 16px">Antworten Sie bitte direkt im Kundenportal – dort sehen Sie auch den aktuellen Stand.`,
      button: { label: 'Nachricht beantworten', href: portalLink(order) + '#nachrichten' }, footer: contactFooter(ws) }) });
}
async function mailSupportChat(env, { toAdmin, session, content, user, attachments }) {
  if (throttled((toAdmin ? 'sup>admin:' : 'sup>user:') + session.id, 3 * 60_000)) return { sent: false };
  const link = `${DASHBOARD_URL}/live-chat?chat=${encodeURIComponent(session.id)}`;
  if (toAdmin) {
    return sendMail(env, null, { to: SUPPORT_TO(env), replyTo: session.user_email || undefined,
      subject: `[Live-Chat ${user.workshop_code || '–'}] ${session.subject || 'Neue Anfrage'}`,
      html: mailHtml({ title: 'Neue Live-Chat-Nachricht', intro: `<b>${esc(session.user_name || session.user_email || 'Ein Nutzer')}</b> (Werkstatt-Code ${esc(user.workshop_code || '–')}) schreibt im Live-Chat:</p>${quote(content, attachments)}<p style="font-size:13px;color:#6b6b88;margin:0 0 16px">Betreff: ${esc(session.subject || '–')}`,
        button: { label: 'Im Live-Chat antworten', href: link }, footer: 'Die Antwort erscheint beim Nutzer sofort im Dashboard; er bekommt zusätzlich eine E-Mail.' }) });
  }
  if (!session.user_email) return { sent: false };
  return sendMail(env, null, { to: session.user_email, replyTo: SUPPORT_TO(env),
    subject: `Antwort vom AutoLeitwerk-Support: ${session.subject || 'Ihre Anfrage'}`,
    html: mailHtml({ title: 'Neue Antwort im Live-Chat', intro: 'Das AutoLeitwerk-Team hat auf Ihre Anfrage geantwortet:</p>' + quote(content, attachments) + '<p style="font-size:13px;color:#6b6b88;margin:0 0 16px">',
      button: { label: 'Im Live-Chat öffnen', href: link }, footer: 'AutoLeitwerk · info@autoleitwerk.de' }) });
}

/* ---------------- Daten-Backup ---------------- */
const EXPORT_ENTITIES = ['Workshop', 'WorkshopProfile', 'Employee', 'Order', 'OrderTask', 'InvoiceItem', 'Service', 'ServiceTaskTemplate',
  'Appointment', 'ApprovalRequest', 'InternalNote', 'MediaItem', 'WorkTime', 'WorkshopLog', 'Notification', 'Lift', 'TireSet',
  'InventoryItem', 'PartOrder', 'OrderMessage', 'ChatSession', 'ChatMessage', 'AlexKnowledge'];
async function exportAll(db) {
  const out = { exported_at: nowIso(), entities: {} };
  for (const e of EXPORT_ENTITIES) {
    try { out.entities[e] = await db.list(e, null); } catch (err) { out.entities[e] = { error: err.code || String(err) }; }
  }
  return out;
}

/* ---------------- Automatisches Backup & Überwachung (Cron) ----------------
 * Täglich 03:30 Uhr (Berlin): alle Daten als JSON in den Speicher, 14 Tage aufbewahrt.
 * Alle 15 Minuten: Datenbank, Tablet, Kundenportal, Dashboard und Backup-Alter prüfen.
 * Mail an info@autoleitwerk.de nur bei Statuswechsel (Störung / wieder OK). */
const BACKUP_PREFIX = '_backup/';
const BACKUP_KEEP_DAYS = 14;
const MONITOR_KEY = '_monitor/state';
const FAIL_THRESHOLD = 2; // erst nach 2 Fehlprüfungen in Folge (30 Min.) alarmieren
const SITE_CHECKS = [
  ['Tablet-App', 'https://kabarabusiness-creator.github.io/werkstattflow-pilot/index.html'],
  ['Kundenportal', 'https://kabarabusiness-creator.github.io/werkstattflow-pilot/kundenapp.html'],
  ['Dashboard', 'https://autoleitwerk.base44.app/'],
];
async function readMonitor(env) {
  try { return (await env.PHOTOS.get(MONITOR_KEY, { type: 'json' })) || {}; } catch { return {}; }
}
async function writeMonitor(env, st) { try { await env.PHOTOS.put(MONITOR_KEY, JSON.stringify(st)); } catch (e) { console.log('monitor_write', String(e)); } }

async function runBackup(env) {
  if (!env.PHOTOS) throw new Error('kein Speicher');
  const db = new Base44(env);
  const data = await exportAll(db);
  const counts = {}; const failed = [];
  for (const [k, v] of Object.entries(data.entities)) { if (Array.isArray(v)) counts[k] = v.length; else failed.push(k); }
  // ohne Komprimierung: spart Rechenzeit (Free-Plan), Speicher reicht für 14 Tage locker
  const raw = JSON.stringify(data);
  const day = berlinToday();
  await env.PHOTOS.put(`${BACKUP_PREFIX}${day}.json`, raw, { metadata: { created_at: nowIso(), bytes: raw.length, records: Object.values(counts).reduce((a, b) => a + b, 0), failed } });
  // alte Backups löschen
  const cutoff = new Date(Date.now() - BACKUP_KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  const listed = await env.PHOTOS.list({ prefix: BACKUP_PREFIX });
  for (const k of listed.keys) { const d = k.name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10); if (d < cutoff) await env.PHOTOS.delete(k.name); }
  const st = await readMonitor(env);
  st.last_backup = { day, at: nowIso(), bytes: raw.length, failed };
  await writeMonitor(env, st);
  return st.last_backup;
}

/* Tiefer Statuscheck für externe Überwachung (z. B. UptimeRobot): 200 = alles ok, 503 = etwas stimmt nicht.
 * /health bleibt bewusst immer 200 (Server lebt). /status erkennt zusätzlich: Prüfung läuft nicht mehr,
 * Störung (Datenbank, Seiten, E-Mail-Schlüssel) oder Backup älter als 36 Std. */
const STATUS_STALE_MS = 45 * 60_000;
async function statusReport(env) {
  const st = env.PHOTOS ? await readMonitor(env) : {};
  const problems = st.down && Array.isArray(st.problems) ? [...st.problems] : [];
  const checkedAge = st.checked_at ? Date.now() - new Date(st.checked_at).getTime() : null;
  if (!env.PHOTOS) problems.push('Speicher nicht eingerichtet');
  else if (checkedAge === null) problems.push('Prüfung noch nie gelaufen');
  else if (checkedAge > STATUS_STALE_MS) problems.push(`Prüfung läuft nicht mehr (letzte vor ${Math.round(checkedAge / 60_000)} Min.)`);
  const lb = st.last_backup && st.last_backup.at;
  if (env.PHOTOS && (!lb || Date.now() - new Date(lb).getTime() > 36 * 3600_000)) problems.push('Backup älter als 36 Std.');
  return { ok: problems.length === 0, problems, checked_at: st.checked_at || null, last_backup: st.last_backup ? st.last_backup.day : null, time: nowIso() };
}

async function listBackups(env) {
  const listed = await env.PHOTOS.list({ prefix: BACKUP_PREFIX });
  return listed.keys.map(k => ({ name: k.name.slice(BACKUP_PREFIX.length), ...(k.metadata || {}) })).sort((a, b) => b.name.localeCompare(a.name));
}

async function runChecks(env) {
  const problems = [];
  const t = async (name, fn) => { try { const r = await fn(); if (r !== true) problems.push(`${name}: ${r}`); } catch (e) { problems.push(`${name}: ${e && e.message || e}`); } };
  await t('Datenbank (Base44)', async () => {
    const res = await fetch(`${env.BASE44_API_BASE || 'https://app.base44.com'}/api/apps/${env.BASE44_APP_ID}/entities/Workshop/v2/list?limit=1`, { headers: { Authorization: `Bearer ${env.BASE44_TOKEN}` } });
    return res.ok ? true : `HTTP ${res.status}`;
  });
  for (const [name, url] of SITE_CHECKS) {
    await t(name, async () => { const r = await fetch(url, { method: 'GET', redirect: 'follow', cf: { cacheTtl: 0 } }); return r.status < 500 && r.status !== 404 ? true : `HTTP ${r.status}`; });
  }
  let st = await readMonitor(env);
  // erstes Backup sofort anlegen (z. B. direkt nach dem Einrichten)
  if (!st.last_backup) { await t('Backup', async () => { await runBackup(env); return true; }); st = await readMonitor(env); }
  const lb = st.last_backup && st.last_backup.at;
  if (!lb || Date.now() - new Date(lb).getTime() > 36 * 3600_000) problems.push(`Backup: letztes Backup ${lb ? 'vom ' + st.last_backup.day : 'fehlt'} (älter als 36 Std.)`);
  else if (st.last_backup.failed && st.last_backup.failed.length) problems.push(`Backup unvollständig: ${st.last_backup.failed.join(', ')}`);
  if (!env.RESEND_API_KEY) problems.push('E-Mail-Versand: Schlüssel fehlt');

  const prevDown = !!st.down;
  const fails = problems.length ? (st.fail_count || 0) + 1 : 0;
  const down = problems.length > 0 && fails >= FAIL_THRESHOLD;
  const changed = down !== prevDown || (down && JSON.stringify(problems) !== JSON.stringify(st.problems || []));
  // checked_at bei jedem Lauf setzen: /status erkennt damit, wenn die Prüfung selbst nicht mehr läuft
  await writeMonitor(env, { ...st, fail_count: fails, down, problems: down ? problems : [], since: down ? (prevDown ? st.since : nowIso()) : null, checked_at: nowIso() });
  if (changed) {
    const list = problems.map(p => `<li>${esc(p)}</li>`).join('');
    await sendMail(env, null, down
      ? { to: SUPPORT_TO(env), subject: '⚠️ AutoLeitwerk: Störung erkannt', html: mailHtml({ title: 'Störung erkannt', intro: `Die automatische Prüfung hat seit über 15 Minuten Probleme festgestellt:</p><ul style="font-size:14.5px;line-height:1.6">${list}</ul><p style="font-size:13px;color:#6b6b88;margin:0 0 16px">Du bekommst eine weitere Mail, sobald alles wieder läuft.`, button: { label: 'Status ansehen', href: 'https://werkstattflow-pilot.werkstattflow.workers.dev/health' } }) }
      : { to: SUPPORT_TO(env), subject: '✅ AutoLeitwerk: alles wieder in Ordnung', html: mailHtml({ title: 'Wieder in Ordnung', intro: `Alle Prüfungen sind wieder grün${st.since ? ` (Störung seit ${new Date(st.since).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })})` : ''}.` }) });
  }
  return { ok: problems.length === 0, problems, down };
}

/* ---------------- Router ---------------- */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '30 1 * * *') {
      ctx.waitUntil(runBackup(env).catch(async e => {
        console.log('backup_failed', String(e));
        await sendMail(env, null, { to: SUPPORT_TO(env), subject: '⚠️ AutoLeitwerk: tägliches Backup fehlgeschlagen', html: mailHtml({ title: 'Backup fehlgeschlagen', intro: esc(String(e && e.message || e)) }) }).catch(() => {});
      }));
    } else {
      ctx.waitUntil(runChecks(env).catch(e => console.log('monitor_failed', String(e))));
    }
  },
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/functions/, '').replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/health') return json({ ok: true, service: 'autoleitwerk-api', configured: !!env.BASE44_TOKEN, photos: !!env.PHOTOS, ai: !!env.AI, email: !!env.RESEND_API_KEY, ...(await (async () => { if (!env.PHOTOS) return {}; const st = await readMonitor(env); return { last_backup: st.last_backup ? st.last_backup.day : null, monitor: st.down ? 'störung' : 'ok', checked_at: st.checked_at || null }; })()), secrets: { BASE44_TOKEN: !!env.BASE44_TOKEN, ADMIN_KEY: !!env.ADMIN_KEY, ADMIN_KEY_long_enough: String(env.ADMIN_KEY || '').trim().length >= 16 }, env_names: Object.keys(env).sort(), time: nowIso() }, 200, cors);
      if (path === '/status') { const r = await statusReport(env); return json(r, r.ok ? 200 : 503, cors); }
      if (path === '/demo' && request.method === 'GET') {
        // Demo-Dashboard: frischer Einmal-Login (60 s gültig) für den Demo-Nutzer, sieht per RLS nur AL-DEMO
        rateLimit('demo:' + (request.headers.get('CF-Connecting-IP') || 'x'), 20, 60_000);
        if (!env.BASE44_TOKEN) throw new HttpError(500, 'server_not_configured');
        const res = await fetch(`${env.BASE44_API_BASE || 'https://app.base44.com'}/api/apps/${env.BASE44_APP_ID}/embed-url`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${env.BASE44_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: env.DEMO_EMAIL || 'demo@autoleitwerk.de', target: 'live_site' }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.embed_url) { console.log('demo_embed', res.status, JSON.stringify(d).slice(0, 200)); throw new HttpError(502, 'demo_unavailable'); }
        return new Response(null, { status: 302, headers: { Location: d.embed_url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      if (path.startsWith('/photo/') && request.method === 'GET') {
        const key = decodeURIComponent(path.slice('/photo/'.length));
        if (!env.PHOTOS || !/^[A-Z0-9-]+\/[a-z0-9]+\/[a-f0-9]{32}\.(jpg|png|webp|pdf)$/i.test(key)) throw new HttpError(404, 'not_found');
        const obj = await env.PHOTOS.getWithMetadata(key, { type: 'stream' });
        if (!obj || !obj.value) throw new HttpError(404, 'not_found');
        const meta = obj.metadata || {};
        const ctype = FILE_TYPES[meta.contentType] ? meta.contentType : 'image/jpeg';
        const headers = { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
        if (meta.name) headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`;
        return new Response(obj.value, { headers });
      }
      const db = new Base44(env);
      let body = {};
      if (request.method === 'POST' && !(request.headers.get('Content-Type') || '').includes('form')) {
        const len = Number(request.headers.get('Content-Length') || 0);
        if (len > 9_000_000) throw new HttpError(413, 'too_large');
        body = await request.json().catch(() => ({}));
      }
      if (path === '/workshopProfiles') return json(await workshopProfiles(db, body, request.headers.get('CF-Connecting-IP') || 'x'), 200, cors);
      if (path === '/workshopLogin') { rateLimit('login:' + (request.headers.get('CF-Connecting-IP') || 'x'), 40, 60_000); return json(await workshopLogin(db, body), 200, cors); }
      if (path === '/getTabletData') return json(await getTabletData(db, await requireSession(db, request)), 200, cors);
      if (path === '/tabletAction') return json(await tabletAction(db, await requireSession(db, request), body, env, url.origin, ctx), 200, cors);
      if (path === '/portalApi') return json(await portalApi(db, body, env, ctx, url.origin), 200, cors);
      if (path === '/fn/portalApi' && request.method === 'POST') return json(await portalApi(db, body, env, ctx, url.origin), 200, cors);
      if (path.startsWith('/fn/') && request.method === 'POST') {
        const r = await handleFunction(path.slice(4), body, { db, env, request, origin: url.origin, h: { HttpError, sha256Hex, randomHex, decodeDataUrl, rateLimit, mailWorkshopMessage, mailSupportChat, storeAttachment, cleanAttachments, ATTACH_MARK }, ctx });
        invalidate('Order');
        return json(r, 200, cors);
      }
      if (path === '/admin' && request.method === 'GET') {
        return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoLeitwerk – Daten-Backup</title>
<style>body{font:16px -apple-system,Segoe UI,sans-serif;background:#f4f4f7;margin:0;padding:40px 16px;color:#1a1a2e}main{max-width:420px;margin:auto;background:#fff;padding:24px;border-radius:14px;box-shadow:0 2px 12px #0001}input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:10px;margin-top:10px}input{border:1px solid #ccd}button{background:#7c3aed;color:#fff;border:0;font-weight:600;cursor:pointer}p{color:#556;font-size:14px}</style></head>
<body><main><h2>Daten-Backup</h2><p>Lädt alle AutoLeitwerk-Daten als JSON-Datei herunter. Datei sicher aufbewahren – sie enthält Kundendaten.</p>
<form method="POST" action="/admin/export"><input type="password" name="key" placeholder="ADMIN_KEY" autocomplete="current-password" required><button type="submit">Backup herunterladen</button></form>
<h2 style="margin-top:28px">Automatische Backups</h2><p>Jede Nacht um 03:30 Uhr, die letzten 14 Tage.</p>
<form method="POST" action="/admin/backups"><input type="password" name="key" placeholder="ADMIN_KEY" autocomplete="current-password" required><button type="submit">Liste anzeigen</button></form></main></body></html>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
      }
      if (path === '/admin/backups' || path === '/admin/backup') {
        if (request.method !== 'POST') throw new HttpError(405, 'method');
        const form = await request.formData();
        const adminKey = String(env.ADMIN_KEY || '').trim();
        if (adminKey.length < 16 || !safeEqual(String(form.get('key') || '').trim(), adminKey)) throw new HttpError(401, 'unauthorized');
        if (!env.PHOTOS) throw new HttpError(503, 'not_available');
        if (path === '/admin/backup') {
          const name = String(form.get('name') || '');
          if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) throw new HttpError(400, 'params');
          const obj = await env.PHOTOS.get(BACKUP_PREFIX + name, { type: 'arrayBuffer' });
          if (!obj) throw new HttpError(404, 'not_found');
          return new Response(obj, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="autoleitwerk-backup-${name}"`, 'Cache-Control': 'no-store' } });
        }
        const rows = await listBackups(env);
        const keyEsc = esc(String(form.get('key')));
        const list = rows.length ? rows.map(b => `<form method="POST" action="/admin/backup" style="display:flex;gap:10px;align-items:center;margin-top:8px"><input type="hidden" name="key" value="${keyEsc}"><input type="hidden" name="name" value="${esc(b.name)}"><span style="flex:1">${esc(b.name.slice(0, 10))} · ${Math.round((b.bytes || 0) / 1024)} KB${b.records != null ? ` · ${b.records} Datensätze` : ''}${b.failed && b.failed.length ? ' · ⚠️ unvollständig' : ''}</span><button type="submit" style="width:auto;margin:0;padding:8px 14px">Laden</button></form>`).join('') : '<p>Noch keine automatischen Backups vorhanden.</p>';
        return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoLeitwerk – Backups</title><style>body{font:16px -apple-system,Segoe UI,sans-serif;background:#f4f4f7;margin:0;padding:40px 16px;color:#1a1a2e}main{max-width:520px;margin:auto;background:#fff;padding:24px;border-radius:14px;box-shadow:0 2px 12px #0001}button{font:inherit;border-radius:10px;background:#7c3aed;color:#fff;border:0;font-weight:600;cursor:pointer}</style></head><body><main><h2>Automatische Backups</h2><p style="color:#556;font-size:14px">Dateien enthalten Kundendaten – sicher aufbewahren.</p>${list}</main></body></html>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
      }
      if (path === '/admin/export') {
        let formKey = '';
        if (request.method === 'POST' && (request.headers.get('Content-Type') || '').includes('form')) {
          formKey = String((await request.formData()).get('key') || '').trim();
        }
        const key = formKey || request.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
        const adminKey = String(env.ADMIN_KEY || '').trim();
        if (adminKey.length < 16 || !safeEqual(String(key).trim(), adminKey)) throw new HttpError(401, 'unauthorized');
        const data = await exportAll(db);
        return new Response(JSON.stringify(data, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="autoleitwerk-daten-${berlinToday()}.json"`, 'Cache-Control': 'no-store', ...cors } });
      }
      throw new HttpError(404, 'not_found');
    } catch (e) {
      if (e instanceof HttpError || (e && e.isHttp)) return json({ error: e.code, ...e.extra }, e.status, cors);
      console.log('unhandled', e && e.stack || String(e));
      return json({ error: 'server_error' }, 500, cors);
    }
  },
};
