/**
 * Ersatz für Base44-Backend-Funktionen des Dashboards (ohne Integrations-Credits).
 * Gleiche Namen, gleiche Request-/Response-Formate wie die Base44-Funktionen, damit das
 * Dashboard nur die Adresse wechseln muss:  POST /fn/<funktionsname>
 *
 * Mit Login (Bearer = Base44-Zugangstoken des Dashboard-Nutzers):
 *   scanTire, scanRegistration, createTireScanToken, createRegistrationScanToken, createPhotoUploadToken
 * Öffentlich (Handy-Seiten, geprüft über Einmal-Token):
 *   tireScanPublic, registrationScanPublic, uploadVehiclePhotoByToken
 *
 * Fotos: Cloudflare KV (statt Base44 UploadFile). Fahrzeugschein-Fotos: nur temporär (30 Min.),
 * nie öffentlich abrufbar, nach der Auswertung gelöscht. KI: Cloudflare Workers AI.
 */
import { tireScanImages, registrationScan, capacityDays } from './ai.js';

const TOKEN_TTL_MIN = 30;
const SLOT_LABELS = { 1: 'Reifenflanke', 2: 'Lauffläche', 3: 'Felge' };
const userCache = new Map();
const recCache = new Map();
const OPEN_DONE = ['abholbereit', 'abgeschlossen'];
const fmtDT = iso => { const d = new Date(iso); if (isNaN(d)) return ''; return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', ''); };
const fmtD = iso => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return d && m ? `${d}.${m}.` : ''; };
const euro = n => Number(n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const berlinIso = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(Date.now() + offsetDays * 86400_000));

// „ALEX empfiehlt“ – feste Regeln, keine KI. Gleiches Format wie die Base44-Funktion alexRecommendations.
export function computeRecommendations({ orders, approvals, appointments, inventory, tires, employees }) {
  const now = Date.now(); const today = berlinIso(0); const in30 = berlinIso(30);
  const recs = [];
  const ref = o => [`#${o.order_number || '?'}`, [o.vehicle_brand, o.vehicle_model].filter(Boolean).join(' '), o.license_plate].filter(Boolean).join(' · ');
  const open = orders.filter(o => !OPEN_DONE.includes(o.status));
  for (const o of open) {
    const due = o.planned_completion ? new Date(o.planned_completion).getTime() : null;
    if (due && due < now) recs.push({ priority: 3, sort: due, title: `Überfällig: ${ref(o)}`, detail: `Fertig geplant ${fmtDT(o.planned_completion)} · Kunde ${o.customer_name || '–'} informieren`, action: { kind: 'open_order', order_id: o.id } });
    else if (o.priority === 'eilig') recs.push({ priority: 3, sort: due || now, title: `Eilig: ${ref(o)}`, detail: `${o.description || 'Eilauftrag'}${o.assigned_mechanic ? ' · ' + o.assigned_mechanic : ' · noch niemand zugewiesen'}`, action: { kind: 'open_order', order_id: o.id } });
    else if (o.planned_completion && String(o.planned_completion).slice(0, 10) === today) recs.push({ priority: 2, sort: due, title: `Heute fertig: ${ref(o)}`, detail: `bis ${fmtDT(o.planned_completion).split(' ')[1] || ''} Uhr · ${o.assigned_mechanic || 'kein Mechaniker zugewiesen'}`, action: { kind: 'open_order', order_id: o.id } });
    if (o.next_hu && o.next_hu >= today && o.next_hu <= in30) recs.push({ priority: 1, sort: now, title: `HU fällig: ${ref(o)}`, detail: `Nächste HU am ${fmtD(o.next_hu)} – gleich mit anbieten`, action: { kind: 'open_order', order_id: o.id } });
  }
  const orderById = Object.fromEntries(orders.map(o => [o.id, o]));
  for (const a of approvals.filter(a => a.status === 'ausstehend')) {
    const o = orderById[a.order_id];
    recs.push({ priority: 3, sort: now - 1, title: `Freigabe offen: ${a.title || 'Zusatzarbeit'} (${euro(a.additional_cost)})`, detail: `${a.customer_name || (o && o.customer_name) || 'Kunde'} · ${[a.vehicle_brand, a.license_plate].filter(Boolean).join(' ') || (o ? ref(o) : '')} – nachfassen`, action: o ? { kind: 'open_order', order_id: o.id } : null });
  }
  const waiting = orders.filter(o => ['warte_auf_ersatzteile', 'ersatzteile_bestellt'].includes(o.status));
  if (waiting.length) recs.push({ priority: 1, sort: now, title: waiting.length === 1 ? '1 Auftrag wartet auf Teile' : `${waiting.length} Aufträge warten auf Teile`, detail: waiting.slice(0, 3).map(ref).join(' · '), action: { kind: 'open_order', order_id: waiting[0].id } });
  for (const i of inventory.filter(i => Number(i.min_stock) > 0 && Number(i.stock_quantity || 0) <= Number(i.min_stock)).slice(0, 2)) {
    recs.push({ priority: 2, sort: now, title: `Nachbestellen: ${i.name}`, detail: `Bestand ${i.stock_quantity || 0} ${i.unit || 'Stück'} (Mindestbestand ${i.min_stock})${i.supplier_name ? ' · ' + i.supplier_name : ''}`, action: null });
  }
  const cap = capacityDays(appointments, employees.length ? employees : [{}], 6).filter(c => c.status === 'rot');
  if (cap.length) recs.push({ priority: 2, sort: now, title: `Werkstatt voll: ${cap.map(c => fmtD(c.datum)).join(', ')}`, detail: `Auslastung ${cap.map(c => c.pct + ' %').join(' / ')} – keine weiteren Termine annehmen oder umplanen`, action: { kind: 'capacity' } });
  const todays = appointments.filter(a => a.appointment_date === today && a.status !== 'storniert').sort((a, b) => String(a.time_slot).localeCompare(String(b.time_slot)));
  if (todays.length) recs.push({ priority: 1, sort: now, title: `Heute ${todays.length} Termin${todays.length > 1 ? 'e' : ''}`, detail: todays.slice(0, 3).map(a => `${a.time_slot || ''} ${a.customer_name || ''} (${a.service_name || a.appointment_type || 'Termin'})`.trim()).join(' · '), action: { kind: 'capacity' } });
  const worn = tires.filter(t => (Number(t.tread_depth) > 0 && Number(t.tread_depth) < 3) || t.condition === 'abgefahren');
  if (worn.length) recs.push({ priority: 1, sort: now, title: `${worn.length} eingelagerte Reifensätze abgefahren`, detail: `${worn.slice(0, 3).map(t => `${t.customer_name || ''} ${t.tread_depth ? t.tread_depth + ' mm' : ''}`.trim()).join(' · ')} – neue Reifen anbieten`, action: { kind: 'tire_list' } });
  return recs.sort((a, b) => b.priority - a.priority || a.sort - b.sort).slice(0, 5).map(({ sort, ...r }) => (r.action ? r : { ...r, action: undefined }));
}

function b64(bytes) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

export async function handleFunction(name, body, c) {
  const { db, env, request, origin, h } = c;
  const { HttpError, sha256Hex, randomHex, decodeDataUrl, rateLimit } = h;
  const ip = request.headers.get('CF-Connecting-IP') || 'x';

  /* ---- Hilfen ---- */
  async function authUser() {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token.length < 20) throw new HttpError(401, 'unauthorized');
    const key = await sha256Hex(token);
    const hit = userCache.get(key);
    if (hit && Date.now() - hit.ts < 300_000) return hit.user;
    const res = await fetch(`${env.BASE44_API_BASE || 'https://app.base44.com'}/api/apps/${env.BASE44_APP_ID}/entities/User/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new HttpError(401, 'unauthorized');
    const u = await res.json().catch(() => null);
    if (!u || !u.id) throw new HttpError(401, 'unauthorized');
    const user = { id: u.id, role: u.role, workshop_code: u.workshop_code || '' };
    userCache.set(key, { ts: Date.now(), user });
    if (userCache.size > 2000) userCache.clear();
    return user;
  }
  function sameWorkshop(rec, code) {
    if (rec.workshop_code && code && rec.workshop_code !== code) throw new HttpError(403, 'forbidden');
  }
  async function getRec(entity, id) {
    try { return await db.get(entity, id); } catch (e) { if (e.extra && e.extra.upstream === 404) return null; throw e; }
  }
  async function resolveToken(entity, token) {
    if (!token || typeof token !== 'string' || token.length < 20) throw new HttpError(401, 'unauthorized');
    const rows = await db.list(entity, { token_hash: await sha256Hex(token) }, { limit: 5 });
    const tok = rows.find(t => t.expires_at && new Date(t.expires_at) > new Date());
    if (!tok) throw new HttpError(401, 'unauthorized');
    return tok;
  }
  function needKv() { if (!env.PHOTOS) throw new HttpError(503, 'not_available', { message: 'Foto-Speicher ist noch nicht eingerichtet.' }); }
  async function storePhoto(code, folder, dataUrl, meta) {
    needKv();
    const { bytes, contentType, ext } = decodeDataUrl(dataUrl);
    const key = `${(code || 'ALLGEMEIN').toUpperCase()}/${folder}/${randomHex(16)}.${ext}`;
    await env.PHOTOS.put(key, bytes, { metadata: { contentType, uploaded_at: new Date().toISOString(), ...(meta || {}) } });
    return `${origin}/photo/${key}`;
  }
  async function photoUrlToDataUrl(url) {
    needKv();
    const prefix = `${origin}/photo/`;
    if (typeof url !== 'string' || !url.startsWith(prefix)) throw new HttpError(400, 'invalid_image_url');
    const obj = await env.PHOTOS.getWithMetadata(decodeURIComponent(url.slice(prefix.length)), { type: 'arrayBuffer' });
    if (!obj || !obj.value) throw new HttpError(404, 'not_found');
    return `data:${(obj.metadata && obj.metadata.contentType) || 'image/jpeg'};base64,${b64(new Uint8Array(obj.value))}`;
  }
  async function newToken(entity, data) {
    const token = randomHex(24);
    const expires = new Date(Date.now() + TOKEN_TTL_MIN * 60_000).toISOString();
    await db.create(entity, { token_hash: await sha256Hex(token), expires_at: expires, ...data });
    return { token, expires_at: expires };
  }
  const readJson = (s, d) => { try { return s ? (typeof s === 'string' ? JSON.parse(s) : s) : d; } catch { return d; } };

  /* ---- Mit Login ---- */
  if (name === 'alexRecommendations') {
    const user = await authUser();
    let code = user.workshop_code;
    if (!code) { const ws = await db.list('Workshop', { owner_user_id: user.id }, { limit: 1 }); code = ws[0] ? ws[0].code : ''; }
    if (!code) return { recommendations: [] };
    const hit = recCache.get(code);
    if (hit && Date.now() - hit.ts < 60_000) return { recommendations: hit.recs };
    const q = { workshop_code: code };
    const [orders, approvals, appointments, inventory, tires, employees] = await Promise.all(
      ['Order', 'ApprovalRequest', 'Appointment', 'InventoryItem', 'TireSet', 'Employee'].map(e => db.list(e, q)));
    const recs = computeRecommendations({ orders, approvals, appointments, inventory, tires, employees: employees.filter(e => e.is_active !== false) });
    recCache.set(code, { ts: Date.now(), recs });
    return { recommendations: recs };
  }

  if (name === 'scanTire') {
    const user = await authUser();
    const dataUrls = (Array.isArray(body.images) ? body.images : []).slice(0, 3);
    const existing = (Array.isArray(body.image_urls) ? body.image_urls : []).slice(0, 3);
    if (!dataUrls.length && !existing.length) throw new HttpError(400, 'params');
    const imageUrls = [...existing];
    const forAi = [];
    for (const u of existing) forAi.push(await photoUrlToDataUrl(u));
    for (const d of dataUrls) { decodeDataUrl(d); forAi.push(d); imageUrls.push(await storePhoto(user.workshop_code, 'reifenscan', d)); }
    const result = await tireScanImages('u:' + user.id, forAi.slice(0, 3), env);
    return { ok: true, result, image_urls: imageUrls };
  }

  if (name === 'scanRegistration') {
    const user = await authUser();
    let images = [];
    let tempKey = null;
    if (body.token) {
      const tok = await resolveToken('RegistrationScanToken', body.token);
      sameWorkshop(tok, user.workshop_code);
      const photo = readJson(tok.photo, null);
      if (!photo || !photo.kv) throw new HttpError(400, 'no_photo');
      needKv();
      const obj = await env.PHOTOS.getWithMetadata(photo.kv, { type: 'arrayBuffer' });
      if (!obj || !obj.value) throw new HttpError(400, 'no_photo');
      images = [`data:${(obj.metadata && obj.metadata.contentType) || 'image/jpeg'};base64,${b64(new Uint8Array(obj.value))}`];
      tempKey = photo.kv;
    } else {
      images = (Array.isArray(body.images) ? body.images : []).slice(0, 2);
      images.forEach(d => decodeDataUrl(d));
    }
    if (!images.length) throw new HttpError(400, 'upload_failed');
    const result = await registrationScan('u:' + user.id, images, env);
    if (tempKey) await env.PHOTOS.delete(tempKey).catch(() => {}); // Datenschutz: Foto sofort löschen
    return { ok: true, result };
  }

  if (name === 'createTireScanToken') {
    const user = await authUser();
    let label = 'Reifenscan – neuer Reifen';
    if (body.order_id) {
      const o = await getRec('Order', body.order_id); if (!o) throw new HttpError(404, 'not_found'); sameWorkshop(o, user.workshop_code);
      label = `Reifenscan – ${o.vehicle_brand || ''} ${o.vehicle_model || ''} · ${o.license_plate || ''}`.replace(/\s+/g, ' ').trim();
    } else if (body.tire_set_id) {
      const t = await getRec('TireSet', body.tire_set_id); if (!t) throw new HttpError(404, 'not_found'); sameWorkshop(t, user.workshop_code);
      label = `Reifenscan – ${t.brand || ''} ${t.model || ''} · ${t.license_plate || t.customer_name || ''}`.replace(/\s+/g, ' ').trim();
    }
    const r = await newToken('TireScanToken', { order_id: body.order_id || '', tire_set_id: body.tire_set_id || '', workshop_code: user.workshop_code, context_label: label, photos: '[]', ready: false });
    return { ...r, context_label: label };
  }

  if (name === 'createRegistrationScanToken') {
    const user = await authUser();
    let label = 'Fahrzeugschein scannen';
    if (body.order_id) {
      const o = await getRec('Order', body.order_id); if (!o) throw new HttpError(404, 'not_found'); sameWorkshop(o, user.workshop_code);
      label = `Fahrzeugschein – ${o.license_plate || o.customer_name || ''}`.trim();
    }
    const r = await newToken('RegistrationScanToken', { order_id: body.order_id || '', workshop_code: user.workshop_code, context_label: label, photo: '', ready: false });
    return { ...r, context_label: label };
  }

  if (name === 'createPhotoUploadToken') {
    const user = await authUser();
    if (!body.order_id && !body.draft_key) throw new HttpError(400, 'params');
    if (body.order_id) { const o = await getRec('Order', body.order_id); if (!o) throw new HttpError(404, 'not_found'); sameWorkshop(o, user.workshop_code); }
    return newToken('PhotoUploadToken', { order_id: body.order_id || '', draft_key: String(body.draft_key || '').slice(0, 80), workshop_code: user.workshop_code, used_count: 0, photo_url: '' });
  }

  /* ---- Öffentlich (Handy) ---- */
  if (name === 'tireScanPublic') {
    rateLimit('pub:' + ip, 60, 60_000);
    const tok = await resolveToken('TireScanToken', body.token);
    const photos = readJson(tok.photos, []);
    if (body.action === 'context') return { label: tok.context_label || 'Reifenscan', order_id: tok.order_id, tire_set_id: tok.tire_set_id, photos };
    if (body.action === 'status') return { photos, ready: !!tok.ready };
    if (body.action === 'finish') { await db.update('TireScanToken', tok.id, { ready: true }); return { ok: true }; }
    if (!body.data_url) throw new HttpError(400, 'params');
    if (photos.length >= 6) throw new HttpError(400, 'too_many_photos');
    const url = await storePhoto(tok.workshop_code, tok.order_id && /^[a-z0-9]+$/.test(tok.order_id) ? tok.order_id : 'reifenscan', body.data_url);
    const slot = Number(body.slot) || 0;
    photos.push({ url, slot, caption: SLOT_LABELS[slot] || 'Reifenscan' });
    await db.update('TireScanToken', tok.id, { photos: JSON.stringify(photos) });
    return { ok: true, file_url: url, photos };
  }

  if (name === 'registrationScanPublic') {
    rateLimit('pub:' + ip, 60, 60_000);
    const tok = await resolveToken('RegistrationScanToken', body.token);
    const photo = readJson(tok.photo, null);
    if (body.action === 'context') return { label: tok.context_label || 'Fahrzeugschein scannen' };
    if (body.action === 'status') return { has_photo: !!photo, ready: !!tok.ready };
    if (body.action === 'finish') { await db.update('RegistrationScanToken', tok.id, { ready: true }); return { ok: true }; }
    if (!body.data_url) throw new HttpError(400, 'params');
    needKv();
    const { bytes, contentType } = decodeDataUrl(body.data_url);
    if (photo && photo.kv) await env.PHOTOS.delete(photo.kv).catch(() => {});
    const key = `regtmp/${randomHex(16)}`; // nie über /photo/ abrufbar, verfällt nach 30 Min.
    await env.PHOTOS.put(key, bytes, { metadata: { contentType }, expirationTtl: TOKEN_TTL_MIN * 60 });
    await db.update('RegistrationScanToken', tok.id, { photo: JSON.stringify({ kv: key }) });
    return { ok: true };
  }

  if (name === 'uploadVehiclePhotoByToken') {
    rateLimit('pub:' + ip, 60, 60_000);
    const tok = await resolveToken('PhotoUploadToken', body.token);
    if (body.action === 'context') {
      if (tok.order_id) {
        const o = await getRec('Order', tok.order_id); if (!o) throw new HttpError(404, 'not_found');
        return { order: { vehicle_brand: o.vehicle_brand || '', vehicle_model: o.vehicle_model || '', license_plate: o.license_plate || '' } };
      }
      return { draft: true, label: 'Fahrzeugfoto' };
    }
    if (body.action === 'status') return { photo_url: tok.photo_url || '', order_id: tok.order_id || '' };
    if (body.action === 'bind') {
      if (!tok.draft_key) throw new HttpError(400, 'not_draft');
      if (!body.order_id) throw new HttpError(400, 'params');
      if (!tok.photo_url) throw new HttpError(400, 'no_photo');
      const o = await getRec('Order', body.order_id); if (!o) throw new HttpError(404, 'not_found');
      if (o.workshop_code && tok.workshop_code && o.workshop_code !== tok.workshop_code) throw new HttpError(403, 'forbidden');
      await db.create('MediaItem', { order_id: o.id, file_url: tok.photo_url, media_type: 'foto', caption: 'Fahrzeugfoto', uploaded_by_name: 'Handy-Upload', workshop_code: tok.workshop_code });
      await db.update('Order', o.id, { vehicle_photo: tok.photo_url });
      await db.remove('PhotoUploadToken', tok.id).catch(() => {});
      return { ok: true, file_url: tok.photo_url };
    }
    if (body.action === 'discard') { await db.remove('PhotoUploadToken', tok.id).catch(() => {}); return { ok: true }; }
    if (!body.data_url) throw new HttpError(400, 'params');
    if ((Number(tok.used_count) || 0) >= 10) throw new HttpError(429, 'too_many_uploads');
    const url = await storePhoto(tok.workshop_code, tok.order_id && /^[a-z0-9]+$/.test(tok.order_id) ? tok.order_id : 'fahrzeugfoto', body.data_url);
    if (tok.order_id) {
      await db.create('MediaItem', { order_id: tok.order_id, file_url: url, media_type: 'foto', caption: 'Fahrzeugfoto', uploaded_by_name: 'Handy-Upload', workshop_code: tok.workshop_code });
      await db.update('Order', tok.order_id, { vehicle_photo: url });
      await db.update('PhotoUploadToken', tok.id, { used_count: (Number(tok.used_count) || 0) + 1 });
    } else {
      await db.update('PhotoUploadToken', tok.id, { photo_url: url, used_count: (Number(tok.used_count) || 0) + 1 });
    }
    return { ok: true, file_url: url };
  }

  throw new HttpError(404, 'unknown_function');
}
