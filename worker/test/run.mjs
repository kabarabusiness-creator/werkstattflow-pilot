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
  if (u.pathname.endsWith('/entities/User/me')) {
    const a = (init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    if (a === 'Bearer USER-AL-T1-xxxxxxxxxxxxxxxx') return new Response(JSON.stringify({ id: 'u1', role: 'user', workshop_code: 'AL-T1' }), { status: 200 });
    return new Response('{"detail":"unauthorized"}', { status: 401 });
  }
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
  if (method === 'DELETE') { table.splice(table.indexOf(rec), 1); return ok({}); }
  return ok(rec);
};

const kv = new Map();
const PHOTOS = {
  async put(k, v, o) { kv.set(k, { v: new Uint8Array(v), m: o && o.metadata }); },
  async delete(k) { kv.delete(k); },
  async getWithMetadata(k, o) { if (o && o.type === 'arrayBuffer') { const e = kv.get(k); return e ? { value: e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength), metadata: e.m } : { value: null, metadata: null }; } const e = kv.get(k); return e ? { value: new Blob([e.v]).stream(), metadata: e.m } : { value: null, metadata: null }; },
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
await t('Profilauswahl: nur aktive eigene Profile, gekürzte Namen, Login per Profil-ID', async () => {
  const r = await call('/workshopProfiles', { workshop_code: 'al-t1' });
  assert.equal(r.status, 200); assert.equal(r.data.workshop_name, 'Testwerkstatt');
  assert.deepEqual(r.data.profiles.map(p => p.name), ['Erika M.']); assert.equal(r.data.profiles[0].pin, undefined);
  assert.equal((await call('/workshopProfiles', { workshop_code: 'XX-999' })).data.error, 'unknown_code');
  const l = await call('/workshopLogin', { workshop_code: 'AL-T1', employee_id: r.data.profiles[0].id, pin: '1234' });
  assert.equal(l.status, 200); assert.equal(l.data.employee.name, 'Erika Muster');
  assert.equal((await call('/workshopLogin', { workshop_code: 'AL-T1', employee_id: 'e2', pin: '1111' })).data.error, 'invalid');
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
await t('Erste Aufgabe startet → Auftrag „Reparatur läuft“ (nur aus „Fahrzeug angenommen“)', async () => {
  db.Order.push({ id: 'o3', workshop_code: 'AL-T1', status: 'fahrzeug_angenommen', customer_name: 'C' });
  db.OrderTask.push({ id: 't3', order_id: 'o3', workshop_code: 'AL-T1', title: 'X', status: 'offen' });
  const r = await call('/tabletAction', { action: 'task_update', task_id: 't3', status: 'in_arbeit' }, token);
  assert.equal(r.data.order_status, 'reparatur_laeuft'); assert.equal(db.Order.at(-1).status, 'reparatur_laeuft');
  db.Order.at(-1).status = 'diagnose_laeuft';
  await call('/tabletAction', { action: 'task_update', task_id: 't3', status: 'erledigt' }, token);
  assert.equal(db.Order.at(-1).status, 'diagnose_laeuft');
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
await t('KI ohne AI-Binding → not_available (kein Absturz)', async () => {
  db.InventoryItem.push({ id: 'i1', workshop_code: 'AL-T1', name: 'Bremsbeläge vorne', part_number: 'BB-1', stock_quantity: 2, min_stock: 4, location: 'C-04' });
  db.InventoryItem.push({ id: 'i2', workshop_code: 'AL-T2', name: 'Bremsbeläge fremd', stock_quantity: 9, min_stock: 1 });
  const r = await call('/tabletAction', { action: 'alex_ask', messages: [{ role: 'user', content: 'Hallo' }] }, token);
  assert.equal(r.status, 503); assert.equal(r.data.error, 'not_available');
});
await t('ALEX: Wissen + Werkstattdaten im Prompt, Karten für Kunde/Auslastung/Lager', async () => {
  db.AlexKnowledge = [{ id: 'k1', title: 'AGR-Ventil P0401', keywords: 'p0401, agr', content: 'P0401: AGR-Durchfluss zu gering. Ventil reinigen.', active: true }];
  let seen;
  env.AI = { async run(model, input) { seen = { model, input }; return { response: 'Prüfe zuerst das **AGR-Ventil** [Eintrag 1].' }; } };
  const r = await call('/tabletAction', { action: 'alex_ask', order_id: 'o1', messages: [{ role: 'user', content: 'Fehlercode P0401, Kunde A, Bremsbeläge auf Lager? Wie voll sind wir Freitag?' }] }, token);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.answer, /AGR/);
  assert.match(r.data.sources[0].title, /P0401/);
  const sys = seen.input.messages[0].content;
  assert.match(sys, /\[Eintrag 1\] .*P0401/); assert.match(sys, /VW Golf AB-C-1/); assert.match(sys, /Bremsbeläge vorne/);
  assert.ok(!/fremd/i.test(sys), 'fremde Werkstattdaten im Prompt');
  const types = r.data.cards.map(c => c.type);
  assert.ok(types.includes('kunde') && types.includes('kapazitaet') && types.includes('teil'), types.join());
  assert.equal(r.data.cards.find(c => c.type === 'kunde').customer.tires.length, 1);
  assert.equal(r.data.cards.find(c => c.type === 'teil').level, 'gelb');
});
await t('ALEX: Tageskontingent leer → ai_quota', async () => {
  env.AI = { async run() { throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } };
  const r = await call('/tabletAction', { action: 'alex_ask', messages: [{ role: 'user', content: 'Was steht heute an?' }] }, token);
  assert.equal(r.status, 503); assert.equal(r.data.error, 'ai_quota');
});
await t('Reifenscan: Bilder an Vision-Modell, Ergebnis normalisiert, Fallback-Modell', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const models = [];
  env.AI = { async run(model, input) {
    models.push(model);
    if (models.length === 1) throw new Error('model error');
    assert.equal(input.messages[0].content.filter(c => c.type === 'image_url').length, 2);
    return { response: '```json\n{"brand":{"value":"Continental","confidence":0.9},"size":{"value":"205/55 R16","confidence":0.8},"season":{"value":"Winter (Alpine)","confidence":0.9},"dot_code":{"value":"DOT XY 2319","confidence":0.6},"tread_depth_mm":{"value":"3,5","confidence":0.5},"tire_damages":[],"rim_damages":[{"type":"Bordsteinschaden","description":"Kratzer","severity":"niedrig"}]}\n```' };
  } };
  const r = await call('/tabletAction', { action: 'tire_scan', order_id: 'o1', images: [png, png] }, token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const x = r.data.result;
  assert.equal(x.brand.value, 'Continental'); assert.equal(x.season.value, 'winter'); assert.equal(x.dot_code.value, '2319');
  assert.equal(x.production_year.value, 2019); assert.ok(x.tire_age_years.value > 6); assert.equal(x.tread_depth_mm.value, 3.5);
  assert.equal(x.rim_damages.length, 1); assert.equal(models.length, 2);
  assert.equal((await call('/tabletAction', { action: 'tire_scan', order_id: 'o2', images: [png] }, token)).status, 404);
  assert.equal((await call('/tabletAction', { action: 'tire_scan', order_id: 'o1', images: ['data:text/html;base64,AAAA'] }, token)).status, 400);
  delete env.AI;
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
await t('Dashboard-Funktionen: Reifenscan per Handy (Token, Upload, Status, Auswertung)', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const U = { Authorization: 'Bearer USER-AL-T1-xxxxxxxxxxxxxxxx' };
  const fn = (name, body, headers) => worker.fetch(new Request('https://api.test/fn/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://autoleitwerk.base44.app', ...(headers || {}) }, body: JSON.stringify(body) }), { ...env, ALLOWED_ORIGINS: env.ALLOWED_ORIGINS + ',https://autoleitwerk.base44.app' }, ctx).then(async r => ({ status: r.status, data: await r.json(), cors: r.headers.get('Access-Control-Allow-Origin') }));
  assert.equal((await fn('createTireScanToken', { order_id: 'o1' })).status, 401);
  assert.equal((await fn('createTireScanToken', { order_id: 'o2' }, U)).status, 403);
  const tk = await fn('createTireScanToken', { order_id: 'o1' }, U);
  assert.equal(tk.status, 200, JSON.stringify(tk.data)); assert.match(tk.data.token, /^[a-f0-9]{48}$/); assert.match(tk.data.context_label, /Golf/); assert.equal(tk.cors, 'https://autoleitwerk.base44.app');
  assert.equal((await fn('tireScanPublic', { token: 'x'.repeat(48), action: 'context' })).status, 401);
  assert.match((await fn('tireScanPublic', { token: tk.data.token, action: 'context' })).data.label, /Reifenscan/);
  const up = await fn('tireScanPublic', { token: tk.data.token, data_url: png, slot: 1 });
  assert.equal(up.data.ok, true); assert.match(up.data.file_url, /\/photo\/AL-T1\/o1\/[a-f0-9]{32}\.png$/);
  await fn('tireScanPublic', { token: tk.data.token, action: 'finish' });
  const st = await fn('tireScanPublic', { token: tk.data.token, action: 'status' });
  assert.equal(st.data.ready, true); assert.equal(st.data.photos.length, 1); assert.equal(st.data.photos[0].caption, 'Reifenflanke');
  let aiInput;
  env.AI = { async run(m, input) { aiInput = input; return { response: '{"brand":{"value":"Michelin","confidence":0.9},"season":{"value":"sommer","confidence":0.8}}' }; } };
  const sc = await fn('scanTire', { image_urls: st.data.photos.map(p => p.url) }, U);
  assert.equal(sc.status, 200, JSON.stringify(sc.data)); assert.equal(sc.data.result.brand.value, 'Michelin');
  assert.match(aiInput.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal((await fn('scanTire', { image_urls: ['https://evil.example/x.jpg'] }, U)).status, 400);
  delete env.AI;
});
await t('Dashboard-Funktionen: Fahrzeugschein per Handy (privat, nach Auswertung gelöscht)', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const U = { Authorization: 'Bearer USER-AL-T1-xxxxxxxxxxxxxxxx' };
  const fn = (name, body, headers) => worker.fetch(new Request('https://api.test/fn/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) }), env, ctx).then(async r => ({ status: r.status, data: await r.json() }));
  const tk = await fn('createRegistrationScanToken', {}, U);
  assert.equal(tk.status, 200);
  assert.equal((await fn('registrationScanPublic', { token: tk.data.token, data_url: png })).data.ok, true);
  assert.equal((await fn('registrationScanPublic', { token: tk.data.token, action: 'status' })).data.has_photo, true);
  const tmpKeys = () => [...kv.keys()].filter(k => k.startsWith('regtmp/'));
  assert.equal(tmpKeys().length, 1);
  env.AI = { async run() { return { response: '{"kennzeichen":{"value":"ab-c 1","confidence":0.9},"fin":{"value":"WVWZZZ1KZ6W000001","confidence":0.9},"hsn":{"value":"0603","confidence":0.95},"tsn":{"value":"bjm","confidence":0.9},"erstzulassung":{"value":"01.03.2015","confidence":0.8},"leistung_kw":{"value":"110 kW","confidence":0.9}}' }; } };
  const r = await fn('scanRegistration', { token: tk.data.token }, U);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.result.hsn.value, '0603'); assert.equal(r.data.result.tsn.value, 'BJM'); assert.equal(r.data.result.kennzeichen.value, 'AB-C 1');
  assert.equal(r.data.result.erstzulassung.value, '2015-03-01'); assert.equal(r.data.result.leistung_kw.value, 110); assert.equal(r.data.result.marke.confidence, 0);
  assert.equal(tmpKeys().length, 0, 'Fahrzeugschein-Foto nicht gelöscht');
  delete env.AI;
});
await t('Dashboard-Funktionen: Fahrzeugfoto per Handy (Entwurf → an Auftrag binden)', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const U = { Authorization: 'Bearer USER-AL-T1-xxxxxxxxxxxxxxxx' };
  const fn = (name, body, headers) => worker.fetch(new Request('https://api.test/fn/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) }), env, ctx).then(async r => ({ status: r.status, data: await r.json() }));
  const tk = await fn('createPhotoUploadToken', { draft_key: 'neu-123' }, U);
  assert.equal((await fn('uploadVehiclePhotoByToken', { token: tk.data.token, action: 'context' })).data.draft, true);
  const up = await fn('uploadVehiclePhotoByToken', { token: tk.data.token, data_url: png });
  assert.match(up.data.file_url, /\/photo\/AL-T1\/fahrzeugfoto\//);
  assert.equal((await fn('uploadVehiclePhotoByToken', { token: tk.data.token, action: 'status' })).data.photo_url, up.data.file_url);
  assert.equal((await fn('uploadVehiclePhotoByToken', { token: tk.data.token, action: 'bind', order_id: 'o2' })).status, 403);
  assert.equal((await fn('uploadVehiclePhotoByToken', { token: tk.data.token, action: 'bind', order_id: 'o1' })).data.ok, true);
  assert.equal(db.Order.find(o => o.id === 'o1').vehicle_photo, up.data.file_url);
  assert.equal((await fn('uploadVehiclePhotoByToken', { token: tk.data.token, action: 'status' })).status, 401, 'Token nach Binden gelöscht');
  const res = await worker.fetch(new Request(up.data.file_url.replace(/^https:\/\/api\.test/, 'https://api.test')), env); assert.equal(res.status, 200);
});
console.log(results.join('\n'));
if (results.some(r => r.startsWith('✗'))) process.exit(1);
