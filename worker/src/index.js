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
 * Variablen (wrangler.toml):
 *   BASE44_APP_ID, ALLOWED_ORIGINS
 *
 * Gleiche Formate wie die Base44-Funktionen: Tablet-Token = 64 Hex-Zeichen,
 * gespeichert als SHA-256 in WorkshopSession; PIN = sha256(salt + ":" + pin).
 */

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

/* ---------------- Login ---------------- */
async function workshopLogin(db, body) {
  const code = String(body.workshop_code || '').trim().toUpperCase();
  const name = norm(body.name);
  const pin = String(body.pin || '').trim();
  if (!code || !name || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'invalid');
  const emps = await db.list('Employee', { workshop_code: code });
  const active = emps.filter(e => e.is_active !== false);
  // exakter Name; sonst eindeutiger Vorname (z. B. „Mert“ statt „Mert Kabara“)
  let emp = active.find(e => norm(e.name) === name);
  if (!emp) {
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
    backend: 'worker',
  };
}

/* ---------------- Tablet-Aktionen ---------------- */
const NOT_AVAILABLE = ['media_upload', 'tire_scan', 'alex_ask', 'alex_execute'];
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
async function tabletAction(db, sess, body) {
  const action = body.action;
  const code = sess.workshop_code;
  if (NOT_AVAILABLE.includes(action)) throw new HttpError(503, 'not_available', { message: 'Diese Funktion ist auf dem eigenen Server noch nicht eingerichtet.' });
  const emp = await employeeOf(db, sess);

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
    return { ok: true };
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
    await db.create('InternalNote', { order_id: body.order_id, content, author_name: emp.name, author_role: ['admin', 'serviceberater', 'mechaniker'].includes(emp.role) ? emp.role : 'mechaniker', workshop_code: code });
    return { ok: true };
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
    return { ok: true };
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
async function portalApi(db, body) {
  const order = await portalOrder(db, body.token);
  const code = order.workshop_code;
  const action = body.action || 'get';

  if (action === 'get') {
    const [approvals, media, apptsByOrder, apptsByToken, services, logs, profiles] = await Promise.all([
      db.list('ApprovalRequest', { order_id: order.id }),
      db.list('MediaItem', { order_id: order.id }),
      db.list('Appointment', { order_id: order.id }),
      db.list('Appointment', { customer_token: order.customer_token }),
      cachedList(db, 'Service'),
      db.list('WorkshopLog', { related_order_id: order.id }),
      cachedList(db, 'WorkshopProfile'),
    ]);
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
    };
  }
  if (action === 'respond') {
    const decision = body.decision;
    if (!['freigegeben', 'abgelehnt', 'rueckruf_angefordert'].includes(decision)) throw new HttpError(400, 'params');
    const ap = await db.get('ApprovalRequest', body.approval_id).catch(() => null);
    if (!ap || ap.order_id !== order.id) throw new HttpError(404, 'not_found');
    if (ap.status !== 'ausstehend' && ap.status !== 'rueckruf_angefordert') throw new HttpError(409, 'already_answered');
    await db.update('ApprovalRequest', ap.id, { status: decision, customer_response_date: nowIso() });
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
    return { ok: true, appointment_id: created.id };
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
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/functions/, '').replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/health') return json({ ok: true, service: 'autoleitwerk-api', configured: !!env.BASE44_TOKEN, secrets: { BASE44_TOKEN: !!env.BASE44_TOKEN, ADMIN_KEY: !!env.ADMIN_KEY, ADMIN_KEY_long_enough: String(env.ADMIN_KEY || '').trim().length >= 16 }, env_names: Object.keys(env).sort(), time: nowIso() }, 200, cors);
      const db = new Base44(env);
      let body = {};
      if (request.method === 'POST' && !(request.headers.get('Content-Type') || '').includes('form')) {
        const len = Number(request.headers.get('Content-Length') || 0);
        if (len > 2_000_000) throw new HttpError(413, 'too_large');
        body = await request.json().catch(() => ({}));
      }
      if (path === '/workshopLogin') return json(await workshopLogin(db, body), 200, cors);
      if (path === '/getTabletData') return json(await getTabletData(db, await requireSession(db, request)), 200, cors);
      if (path === '/tabletAction') return json(await tabletAction(db, await requireSession(db, request), body), 200, cors);
      if (path === '/portalApi') return json(await portalApi(db, body), 200, cors);
      if (path === '/admin' && request.method === 'GET') {
        return new Response(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoLeitwerk – Daten-Backup</title>
<style>body{font:16px -apple-system,Segoe UI,sans-serif;background:#f4f4f7;margin:0;padding:40px 16px;color:#1a1a2e}main{max-width:420px;margin:auto;background:#fff;padding:24px;border-radius:14px;box-shadow:0 2px 12px #0001}input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:10px;margin-top:10px}input{border:1px solid #ccd}button{background:#7c3aed;color:#fff;border:0;font-weight:600;cursor:pointer}p{color:#556;font-size:14px}</style></head>
<body><main><h2>Daten-Backup</h2><p>Lädt alle AutoLeitwerk-Daten als JSON-Datei herunter. Datei sicher aufbewahren – sie enthält Kundendaten.</p>
<form method="POST" action="/admin/export"><input type="password" name="key" placeholder="ADMIN_KEY" autocomplete="current-password" required><button type="submit">Backup herunterladen</button></form></main></body></html>`,
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
      if (e instanceof HttpError) return json({ error: e.code, ...e.extra }, e.status, cors);
      console.log('unhandled', e && e.stack || String(e));
      return json({ error: 'server_error' }, 500, cors);
    }
  },
};
