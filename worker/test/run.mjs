// Lokaler Test des Workers gegen eine nachgebaute Base44-Apps-API (keine echten Daten, kein Netz).
// Aufruf: node worker/test/run.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';

const sha = s => createHash('sha256').update(s).digest('hex');
const APP = 'app1';
let seq = 0;
const db = {
  Workshop: [{ id: 'w1', code: 'AL-T1', name: 'Testwerkstatt', trial_ends_at: '2026-10-21', subscription_status: 'trial' }],
  WorkshopProfile: [{ id: 'p1', workshop_code: 'AL-T1', company_name: 'Testwerkstatt GmbH', phone: '0123', email: 'a@b.de', address_street: 'Str. 1', address_zip: '12345', address_city: 'Ort' }],
  Employee: [
    { id: 'e1', name: 'Erika Muster', role: 'admin', is_active: true, workshop_code: 'AL-T1', pin_salt: 'abc', pin: sha('abc:1234'), failed_attempts: 0 },
    { id: 'e2', name: 'Otto Fremd', role: 'admin', is_active: true, workshop_code: 'AL-T2', pin_salt: 'x', pin: sha('x:1111') },
  ],
  Order: [
    { id: 'o1', order_number: '2001', email: 'kunde@example.com', phone: '0170', workshop_code: 'AL-T1', customer_name: 'Kunde A', license_plate: 'AB-C-1', vehicle_brand: 'VW', vehicle_model: 'Golf', status: 'reparatur_laeuft', customer_token: 'tok-aaaaaa', billing_street: 'geheim' },
    { id: 'o2', workshop_code: 'AL-T2', customer_name: 'Fremd', license_plate: 'X', status: 'fahrzeug_angenommen', customer_token: 'tok-bbbbbb' },
  ],
  OrderTask: [{ id: 't1', order_id: 'o1', workshop_code: 'AL-T1', title: 'Öl', status: 'offen' }, { id: 't2', order_id: 'o2', workshop_code: 'AL-T2', title: 'X', status: 'offen' }],
  WorkTime: [], Lift: [], Appointment: [], TireSet: [{ id: 'r1', workshop_code: 'AL-T1', customer_name: 'Kunde A', season: 'winter', tread_depth: 5 }],
  WorkshopSession: [], InternalNote: [], WorkshopLog: [], ApprovalRequest: [{ id: 'a1', order_id: 'o1', status: 'ausstehend', title: 'Bremse', additional_cost: 120 }],
  MediaItem: [], Service: [{ id: 's1', name: 'Inspektion', is_active: true, workshop_code: 'AL-T1', estimated_duration_minutes: 60 }], InventoryItem: [],
};
const calls = [];
const mails = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url); const method = init.method || 'GET';
  if (u.host === 'api.resend.com') { assert.equal(init.headers.Authorization, 'Bearer RE_TEST'); mails.push(JSON.parse(init.body)); return new Response('{"id":"m1"}', { status: 200 }); }
  assert.equal(init.headers.Authorization, 'Bearer TEST');
  const m = u.pathname.match(/^\/api\/apps\/app1\/entities\/(\w+)(?:\/(v2\/list|[^/]+))?$/);
  assert.ok(m, 'unexpected url ' + u.pathname);
  const [, ent, rest] = m; calls.push(method + ' ' + ent);
  const table = db[ent] || (db[ent] = []);
  const ok = d => new Response(JSON.stringify(d), { status: 200 });
  if (rest === 'v2/list') {
    const q = u.searchParams.get('q') ? JSON.parse(u.searchParams.get('q')) : {};
    const items = table.filter(r => Object.entries(q).every(([k, v]) => r[k] === v));
    return ok({ items, has_more: false, next_cursor: null });
  }
  if (method === 'POST') { const rec = { id: 'n' + (++seq), created_date: new Date().toISOString(), ...JSON.parse(init.body) }; table.push(rec); return ok(rec); }
  const rec = table.find(r => r.id === decodeURIComponent(rest));
  if (!rec) return new Response('{"detail":"not found"}', { status: 404 });
  if (method === 'PUT') { Object.assign(rec, JSON.parse(init.body)); return ok(rec); }
  return ok(rec);
};

const kv = new Map();
const PHOTOS = {
  async put(k, v, o) { kv.set(k, { v: new Uint8Array(v), m: o && o.metadata }); },
  async getWithMetadata(k) { const e = kv.get(k); return e ? { value: new Blob([e.v]).stream(), metadata: e.m } : { value: null, metadata: null }; },
};
const env = { PHOTOS, RESEND_API_KEY: 'RE_TEST', BASE44_TOKEN: 'TEST', BASE44_APP_ID: APP, ALLOWED_ORIGINS: 'https://kabarabusiness-creator.github.io', ADMIN_KEY: 'x'.repeat(20) };
const pending = []; const ctx = { waitUntil: p => pending.push(p) };
async function call(path, body, token, method = 'POST', headers = {}) {
  const res = await worker.fetch(new Request('https://api.test/functions' + path, {
    method, headers: { 'Content-Type': 'application/json', Origin: 'https://kabarabusiness-creator.github.io', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  }), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: res.status, data: await res.json(), cors: res.headers.get('Access-Control-Allow-Origin') };
}
const results = [];
async function t(name, fn) { try { await fn(); results.push('✓ ' + name); } catch (e) { results.push('✗ ' + name + ': ' + e.message); } }

let token;
await t('Login richtiger PIN (Vorname reicht)', async () => {
  const r = await call('/workshopLogin', { workshop_code: 'al-t1', name: 'erika', pin: '1234' });
  assert.equal(r.status, 200); assert.match(r.data.token, /^[a-f0-9]{64}$/); assert.equal(r.data.employee.role, 'admin');
  assert.equal(r.cors, 'https://kabarabusiness-creator.github.io');
  token = r.data.token;
  assert.equal(db.WorkshopSession.at(-1).token_hash, sha(token));
});
await t('Login falscher PIN → invalid, nach 5 Versuchen gesperrt', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await call('/workshopLogin', { workshop_code: 'AL-T1', name: 'Erika Muster', pin: '0000' })).data.error, 'invalid');
  const r = await call('/workshopLogin', { workshop_code: 'AL-T1', name: 'Erika Muster', pin: '0000' });
  assert.equal(r.status, 423); assert.equal(r.data.error, 'locked'); assert.ok(r.data.retry_at);
  const r2 = await call('/workshopLogin', { workshop_code: 'AL-T1', name: 'Erika Muster', pin: '1234' });
  assert.equal(r2.data.error, 'locked');
  db.Employee[0].locked_until = null;
});
await t('Fremde Werkstatt-Mitarbeiter nicht anmeldbar', async () => {
  assert.equal((await call('/workshopLogin', { workshop_code: 'AL-T1', name: 'Otto Fremd', pin: '1111' })).data.error, 'invalid');
});
await t('Tablet-Daten nur eigene Werkstatt, ohne Token/PIN', async () => {
  const r = await call('/getTabletData', null, token, 'GET');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.orders.map(o => o.id), ['o1']); assert.equal(r.data.orders[0].customer_token, undefined); assert.equal(r.data.orders[0].has_portal, true);
  assert.deepEqual(r.data.tasks.map(x => x.id), ['t1']);
  assert.equal(r.data.employees[0].pin, undefined); assert.equal(r.data.employees[0].pin_salt, undefined);
  assert.equal(r.data.workshop.name, 'Testwerkstatt'); assert.equal(r.data.tire_sets.length, 1);
});
await t('Ohne/ungültiger Token → 401', async () => {
  assert.equal((await call('/getTabletData', null, null, 'GET')).status, 401);
  assert.equal((await call('/getTabletData', null, 'f'.repeat(64), 'GET')).status, 401);
});
await t('Cache: zweiter Abruf ohne neue Datenbank-Listen', async () => {
  const before = calls.length; await call('/getTabletData', null, token, 'GET'); assert.equal(calls.length, before);
});
await t('Aufgabe erledigen', async () => {
  const r = await call('/tabletAction', { action: 'task_update', task_id: 't1', status: 'erledigt' }, token);
  assert.equal(r.data.ok, true); assert.equal(db.OrderTask[0].status, 'erledigt'); assert.equal(db.OrderTask[0].completed_by, 'Erika Muster');
});
await t('Fremde Aufgabe nicht änderbar', async () => {
  const r = await call('/tabletAction', { action: 'task_update', task_id: 't2', status: 'erledigt' }, token);
  assert.equal(r.status, 404); assert.equal(db.OrderTask[1].status, 'offen');
});
await t('Zeiterfassung Start/Stop', async () => {
  const s = await call('/tabletAction', { action: 'worktime_start', order_id: 'o1', task_id: 't1', description: 'Öl' }, token);
  assert.ok(s.data.worktime_id);
  const wt = db.WorkTime.find(w => w.id === s.data.worktime_id); wt.start_timestamp = new Date(Date.now() - 25 * 60000).toISOString();
  const e = await call('/tabletAction', { action: 'worktime_stop', worktime_id: s.data.worktime_id }, token);
  assert.equal(e.data.duration_minutes, 25);
});
await t('Notiz + Auftrag abschließen', async () => {
  assert.equal((await call('/tabletAction', { action: 'note_add', order_id: 'o1', content: 'Hallo' }, token)).data.ok, true);
  const r = await call('/tabletAction', { action: 'order_complete', order_id: 'o1', qc: [{ label: 'Probefahrt', checked: true }] }, token);
  assert.equal(r.data.ok, true); assert.equal(db.Order[0].status, 'abholbereit'); assert.match(db.WorkshopLog.at(-1).description, /✓ Probefahrt/);
});
await t('Reifensatz aktualisieren + Validierung', async () => {
  assert.equal((await call('/tabletAction', { action: 'tire_update', id: 'r1', tread_depth: 3.5, storage_rack: '04' }, token)).data.ok, true);
  assert.equal(db.TireSet[0].tread_depth, 3.5);
  assert.equal((await call('/tabletAction', { action: 'tire_update', id: 'r1', season: 'herbst' }, token)).status, 400);
});
await t('KI → not_available (kein Absturz)', async () => {
  const r = await call('/tabletAction', { action: 'tire_scan', order_id: 'o1' }, token);
  assert.equal(r.status, 503); assert.equal(r.data.error, 'not_available');
});
await t('Foto hochladen, als Fahrzeugfoto setzen und ausliefern', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await call('/tabletAction', { action: 'media_upload', order_id: 'o1', data_url: png, caption: 'Fahrzeugfoto', set_as_vehicle_photo: true }, token);
  assert.equal(r.data.ok, true); assert.match(r.data.file_url, /^https:\/\/api\.test\/photo\/AL-T1\/o1\/[a-f0-9]{32}\.png$/);
  assert.equal(db.Order[0].vehicle_photo, r.data.file_url); assert.equal(db.MediaItem.at(-1).file_url, r.data.file_url);
  const img = await worker.fetch(new Request(r.data.file_url), env);
  assert.equal(img.status, 200); assert.equal(img.headers.get('Content-Type'), 'image/png'); assert.equal((await img.arrayBuffer()).byteLength, 70);
  assert.equal((await call('/tabletAction', { action: 'media_upload', order_id: 'o2', data_url: png }, token)).status, 404);
  assert.equal((await call('/tabletAction', { action: 'media_upload', order_id: 'o1', data_url: 'data:text/html;base64,PGI+' }, token)).data.error, 'invalid_image');
  assert.equal((await worker.fetch(new Request('https://api.test/photo/../../x'), env)).status, 404);
});
await t('Portal: get liefert nur eigenen Auftrag, ohne Token/Rechnungsadresse', async () => {
  const r = await call('/portalApi', { action: 'get', token: 'tok-aaaaaa' });
  assert.equal(r.status, 200); assert.equal(r.data.order.id, 'o1'); assert.equal(r.data.order.customer_token, undefined); assert.equal(r.data.order.billing_street, undefined);
  assert.equal(r.data.approvals.length, 1); assert.equal(r.data.services.length, 1); assert.equal(r.data.workshop.name, 'Testwerkstatt GmbH');
  assert.equal((await call('/portalApi', { action: 'get', token: 'falsch-123' })).data.error, 'not_found');
});
function nextWeekday() { const d = new Date(Date.now() + 2 * 86400000); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
await t('Portal: buchen, Doppelbuchung, Sonntag, stornieren', async () => {
  const date = nextWeekday();
  const b = await call('/portalApi', { action: 'book', token: 'tok-aaaaaa', appointment: { appointment_date: date, time_slot: '09:00', appointment_type: 'inspektion', service_id: 's1' } });
  assert.equal(b.data.ok, true);
  const dup = await call('/portalApi', { action: 'book', token: 'tok-aaaaaa', appointment: { appointment_date: date, time_slot: '09:00' } });
  assert.equal(dup.data.error, 'slot_taken');
  const sun = new Date(); sun.setUTCDate(sun.getUTCDate() + ((7 - sun.getUTCDay()) % 7 || 7));
  assert.equal((await call('/portalApi', { action: 'book', token: 'tok-aaaaaa', appointment: { appointment_date: sun.toISOString().slice(0, 10), time_slot: '09:00' } })).data.error, 'invalid_slot');
  assert.equal((await call('/portalApi', { action: 'book', token: 'tok-aaaaaa', appointment: { appointment_date: date, time_slot: '12:00' } })).data.error, 'invalid_slot');
  const g = await call('/portalApi', { action: 'get', token: 'tok-aaaaaa' });
  assert.equal(g.data.appointments.length, 1); assert.equal(g.data.appointments[0].customer_token, undefined);
  assert.equal((await call('/portalApi', { action: 'cancel', token: 'tok-aaaaaa', appointment_id: b.data.appointment_id })).data.ok, true);
  assert.equal((await call('/portalApi', { action: 'cancel', token: 'tok-bbbbbb', appointment_id: b.data.appointment_id })).status, 404);
});
await t('Portal: Freigabe beantworten (nur einmal)', async () => {
  assert.equal((await call('/portalApi', { action: 'respond', token: 'tok-aaaaaa', approval_id: 'a1', decision: 'freigegeben' })).data.ok, true);
  assert.equal((await call('/portalApi', { action: 'respond', token: 'tok-aaaaaa', approval_id: 'a1', decision: 'abgelehnt' })).status, 409);
});
await t('Admin-Export nur mit Schlüssel', async () => {
  assert.equal((await call('/admin/export', null, null, 'GET')).status, 401);
  const res = await worker.fetch(new Request('https://api.test/admin/export', { headers: { 'X-Admin-Key': 'x'.repeat(20) } }), env);
  const d = await res.json(); assert.equal(res.status, 200); assert.ok(Array.isArray(d.entities.Order));
});
await t('Ohne Token-Konfiguration: Health ok, API meldet server_not_configured', async () => {
  const h = await worker.fetch(new Request('https://api.test/health'), {}); assert.equal((await h.json()).configured, false);
  const r = await worker.fetch(new Request('https://api.test/workshopLogin', { method: 'POST', body: '{}' }), {}); assert.equal((await r.json()).error, 'server_not_configured');
});
await t('E-Mails: Abholbereit, Termin (Kunde + Werkstatt), Freigabe, Portal-Link', async () => {
  const subjects = mails.map(m => m.subject).join(' | ');
  assert.match(subjects, /ist abholbereit/); assert.match(subjects, /Terminanfrage bei Testwerkstatt GmbH/); assert.match(subjects, /Neue Online-Terminanfrage/); assert.match(subjects, /Freigabe ✅ freigegeben/);
  assert.ok(mails.every(m => !/<script/i.test(m.html)));
  const before = mails.length;
  const r = await call('/tabletAction', { action: 'send_portal_link', order_id: 'o1' }, token);
  assert.equal(r.data.ok, true); assert.equal(r.data.sent_to, 'k…@example.com'); assert.equal(mails.length, before + 1);
  assert.match(mails.at(-1).html, /kundenapp\.html\?token=tok-aaaaaa/); assert.equal(mails.at(-1).reply_to, 'a@b.de');
  assert.ok(db.Notification.some(n => n.status_text === 'Portal-Link' && n.delivery_state === 'gesendet'));
});
console.log(results.join('\n'));
if (results.some(r => r.startsWith('✗'))) process.exit(1);
