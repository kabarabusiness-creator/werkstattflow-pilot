/**
 * CEO-Konsole (nur Inhaber): /ceo (Seite) + POST /ceo/api (JSON).
 *
 * Zugang ausschließlich für die CEO-Adresse (env.CEO_EMAIL, Standard info@autoleitwerk.de):
 * 6-stelliger Einmal-Code per E-Mail → Sitzung 12 Std. (nur Hash im Speicher).
 * Jede Anfrage wird serverseitig geprüft – kein Werkstatt-Login und kein Base44-Admin kommt hier rein.
 */
import { renderCeoPage } from './ceo_page.js';

const CODE_KEY = '_ceo/code';
const SESS_PREFIX = '_ceo/sess/';
export const SETTINGS_KEY = '_ceo/settings';
export const TICKET_PREFIX = '_tickets/';
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_TRIES = 5;
const SESSION_HOURS = 12;

// Funktionen, die der Server selbst durchsetzt (Tablet/Portal/KI) + die Module des Base44-Dashboards
export const SERVER_MODULES = [
  { key: 'tablet', label: 'Tablet-App', server: true },
  { key: 'alex', label: 'ALEX (KI-Assistent)', server: true },
  { key: 'reifenscan', label: 'Reifenscan (KI)', server: true },
  { key: 'kundenportal', label: 'Kundenportal', server: true },
];
export const DASHBOARD_MODULES = [
  ['dashboard', 'Dashboard'], ['orders', 'Aufträge'], ['werkstatt', 'Werkstatt / Leitstelle'], ['hebebuehnen', 'Hebebühnen'],
  ['approvals', 'Freigaben'], ['appointments', 'Termine'], ['kalender', 'Kalender'], ['kunden', 'Kunden'], ['fahrzeuge', 'Fahrzeuge'],
  ['lager', 'Teile Lager'], ['reifenlager', 'Reifenlager'], ['arbeitszeiten', 'Arbeitszeiten'], ['dienstleistungen', 'Dienstleistungen'],
  ['mitarbeiter', 'Mitarbeiter'], ['kapazitaetsplanung', 'Kapazitätsplanung'], ['rechnungen', 'Rechnungen'], ['protokolle', 'Protokolle'],
  ['berichte', 'Berichte'], ['live_chat', 'Live-Chat'], ['notifications', 'Benachrichtigungen'],
].map(([key, label]) => ({ key, label, server: false }));
const ALL_MODULE_KEYS = new Set([...SERVER_MODULES, ...DASHBOARD_MODULES].map(m => m.key));

export const DEFAULT_SETTINGS = { maintenance: false, maintenance_message: 'Wartungsarbeiten – bitte in ein paar Minuten erneut versuchen.', announcement: '' };
let settingsCache = null;
export async function readSettings(env) {
  if (settingsCache && Date.now() - settingsCache.ts < 30_000) return settingsCache.v;
  let v = DEFAULT_SETTINGS;
  try { const s = env.PHOTOS ? await env.PHOTOS.get(SETTINGS_KEY, { type: 'json' }) : null; if (s) v = { ...DEFAULT_SETTINGS, ...s }; } catch { /* Standard */ }
  settingsCache = { ts: Date.now(), v };
  return v;
}
export function parseModules(ws) {
  try { const m = JSON.parse((ws && ws.enabled_modules) || '{}'); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

// Kurzzeit-Fehlerprotokoll (pro Server-Instanz) für die Entwickler-Ansicht
const recentErrors = [];
export function logError(where, err) {
  recentErrors.unshift({ at: new Date().toISOString(), where: String(where).slice(0, 120), error: String(err && (err.stack || err.message) || err).slice(0, 600) });
  if (recentErrors.length > 50) recentErrors.length = 50;
}

const ceoEmail = env => String(env.CEO_EMAIL || 'info@autoleitwerk.de').trim().toLowerCase();
const sessCache = new Map();

export async function handleCeo(request, env, ctx, d) {
  const { HttpError, sha256Hex, randomHex, safeEqual, nowIso } = d;
  const url = new URL(request.url);
  const secHeaders = {
    'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...secHeaders } });

  if (url.pathname === '/ceo' && request.method === 'GET') {
    return new Response(renderCeoPage(), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...secHeaders } });
  }
  if (url.pathname !== '/ceo/api' || request.method !== 'POST') throw new HttpError(404, 'not_found');
  // nur von der eigenen Seite (kein Aufruf aus fremden Websites)
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'forbidden');
  if (!env.PHOTOS) throw new HttpError(503, 'not_available', { message: 'Speicher ist nicht eingerichtet.' });

  let body = {};
  try { body = await request.json(); } catch { throw new HttpError(400, 'params'); }
  const action = String(body.action || '');
  const ip = request.headers.get('CF-Connecting-IP') || 'x';

  /* ---------- Anmeldung ---------- */
  if (action === 'request_code') {
    d.rateLimit('ceo-code:' + ip, 5, 15 * 60_000);
    const email = String(body.email || '').trim().toLowerCase();
    // gleiche Antwort für jede Adresse – verrät nicht, welche Adresse berechtigt ist
    if (email && safeEqual(email, ceoEmail(env))) {
      const prev = await env.PHOTOS.get(CODE_KEY, { type: 'json' }).catch(() => null);
      if (!(prev && prev.sent_at && Date.now() - prev.sent_at < 45_000)) {
        const n = new Uint32Array(1); crypto.getRandomValues(n);
        const code = String(n[0] % 1_000_000).padStart(6, '0');
        await env.PHOTOS.put(CODE_KEY, JSON.stringify({ hash: await sha256Hex('ceo:' + code), exp: Date.now() + CODE_TTL_MS, tries: 0, sent_at: Date.now() }), { expirationTtl: 900 });
        await d.sendMail(env, null, {
          to: ceoEmail(env), subject: `AutoLeitwerk CEO-Konsole: Anmeldecode ${code}`,
          html: d.mailHtml({ title: 'Anmeldecode', intro: `Dein Code für die CEO-Konsole:</p><p style="font-size:30px;font-weight:800;letter-spacing:6px;margin:8px 0 18px">${code}</p><p style="font-size:13px;color:#6b6b88;margin:0 0 16px">Gültig für 10 Minuten. Angefordert von IP ${d.esc(ip)} um ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}. Wenn du das nicht warst, ignoriere diese Mail.`, footer: 'AutoLeitwerk · CEO-Konsole' }),
        });
      }
    }
    return out({ ok: true });
  }
  if (action === 'login') {
    d.rateLimit('ceo-login:' + ip, 10, 15 * 60_000);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\D/g, '');
    const rec = await env.PHOTOS.get(CODE_KEY, { type: 'json' }).catch(() => null);
    const bad = () => { throw new HttpError(401, 'invalid', { message: 'Code falsch oder abgelaufen.' }); };
    if (!rec || !rec.hash || Date.now() > rec.exp || !email || !safeEqual(email, ceoEmail(env)) || code.length !== 6) bad();
    if (!safeEqual(await sha256Hex('ceo:' + code), rec.hash)) {
      rec.tries = (rec.tries || 0) + 1;
      if (rec.tries >= CODE_MAX_TRIES) await env.PHOTOS.delete(CODE_KEY); else await env.PHOTOS.put(CODE_KEY, JSON.stringify(rec), { expirationTtl: 900 });
      bad();
    }
    await env.PHOTOS.delete(CODE_KEY);
    const token = randomHex(32);
    const exp = Date.now() + SESSION_HOURS * 3600_000;
    await env.PHOTOS.put(SESS_PREFIX + await sha256Hex(token), JSON.stringify({ exp, created_at: nowIso(), ip }), { expirationTtl: SESSION_HOURS * 3600 });
    return out({ ok: true, token, expires_at: new Date(exp).toISOString() });
  }

  /* ---------- ab hier nur mit CEO-Sitzung ---------- */
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'unauthorized');
  const sKey = SESS_PREFIX + await sha256Hex(token);
  let sess = sessCache.get(sKey);
  if (!sess || Date.now() - sess.ts > 60_000) { sess = { ts: Date.now(), v: await env.PHOTOS.get(sKey, { type: 'json' }).catch(() => null) }; sessCache.set(sKey, sess); }
  if (!sess.v || Date.now() > sess.v.exp) throw new HttpError(401, 'unauthorized');
  if (sessCache.size > 200) sessCache.clear();
  const db = new d.Base44(env);

  if (action === 'logout') { await env.PHOTOS.delete(sKey); sessCache.delete(sKey); return out({ ok: true }); }

  if (action === 'overview') {
    const [workshops, orders, employees, appts, sessions, chats, worktimes] = await Promise.all([
      db.list('Workshop', null), db.list('Order', null, { sort: '-updated_date' }), db.list('Employee', null), db.list('Appointment', null),
      db.list('WorkshopSession', null, { sort: '-created_date', limit: 500 }).catch(() => []), db.list('ChatSession', null).catch(() => []),
      db.list('WorkTime', null, { sort: '-created_date', limit: 1000 }).catch(() => []),
    ]);
    const tickets = await listTickets(env);
    const today = d.berlinToday();
    const in7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const latest = (...xs) => xs.filter(Boolean).sort().pop() || null;
    const rows = workshops.map(w => {
      const c = w.code;
      const wo = orders.filter(o => o.workshop_code === c);
      const ws = sessions.filter(s => s.workshop_code === c);
      return {
        id: w.id, code: c, name: w.name, is_active: w.is_active !== false, subscription_status: w.subscription_status || 'trial', trial_ends_at: w.trial_ends_at || null,
        modules: parseModules(w),
        orders_active: wo.filter(o => !['abgeschlossen'].includes(o.status)).length, orders_total: wo.length,
        orders_month: wo.filter(o => String(o.created_date || '').slice(0, 7) === today.slice(0, 7)).length,
        revenue_month: Math.round(wo.filter(o => String(o.invoice_date || '').slice(0, 7) === today.slice(0, 7)).reduce((s, o) => s + (Number(o.total_amount) || 0), 0)),
        employees: employees.filter(e => e.workshop_code === c && e.is_active !== false).length,
        appts_week: appts.filter(a => a.workshop_code === c && a.status !== 'storniert' && String(a.appointment_date || '') >= today && String(a.appointment_date || '') <= in7).length,
        last_activity: latest(wo[0] && wo[0].updated_date, ws[0] && ws[0].created_date, (worktimes.find(x => x.workshop_code === c) || {}).created_date),
        tablet_logins_7d: ws.filter(s => Date.now() - Date.parse(String(s.created_date || s.created_at || '') + (/Z$/.test(String(s.created_date || '')) ? '' : 'Z')) < 7 * 86400_000).length,
      };
    }).sort((a, b) => String(b.last_activity || '').localeCompare(String(a.last_activity || '')));
    return out({
      ok: true, workshops: rows,
      modules: { server: SERVER_MODULES, dashboard: DASHBOARD_MODULES },
      totals: {
        workshops: rows.length, active: rows.filter(r => r.is_active).length, paying: rows.filter(r => r.subscription_status === 'active').length,
        trial: rows.filter(r => r.subscription_status === 'trial').length, orders_active: rows.reduce((s, r) => s + r.orders_active, 0),
        employees: rows.reduce((s, r) => s + r.employees, 0),
        support_open: chats.filter(c => c.status !== 'abgeschlossen' && c.unread_admin).length + tickets.filter(t => t.status !== 'erledigt').length,
      },
      status: await d.statusReport(env), settings: await readSettings(env),
    });
  }

  if (action === 'workshop_update') {
    const w = await db.get('Workshop', String(body.id || '')).catch(() => null);
    if (!w) throw new HttpError(404, 'not_found');
    const upd = {};
    if (typeof body.is_active === 'boolean') upd.is_active = body.is_active;
    if (['trial', 'active', 'expired'].includes(body.subscription_status)) upd.subscription_status = body.subscription_status;
    if (body.trial_ends_at === null || (typeof body.trial_ends_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.trial_ends_at))) upd.trial_ends_at = body.trial_ends_at;
    if (typeof body.name === 'string' && body.name.trim()) upd.name = body.name.trim().slice(0, 120);
    if (body.modules && typeof body.modules === 'object') {
      const m = parseModules(w);
      for (const [k, v] of Object.entries(body.modules)) if (ALL_MODULE_KEYS.has(k) && typeof v === 'boolean') m[k] = v;
      upd.enabled_modules = JSON.stringify(m);
    }
    if (!Object.keys(upd).length) throw new HttpError(400, 'params');
    await db.update('Workshop', w.id, upd);
    d.invalidate('Workshop');
    return out({ ok: true });
  }

  /* ---------- Support ---------- */
  if (action === 'support_list') {
    const chats = (await db.list('ChatSession', null).catch(() => []))
      .sort((a, b) => String(b.last_message_at || b.updated_date || '').localeCompare(String(a.last_message_at || a.updated_date || '')))
      .map(c => ({ id: c.id, subject: c.subject, status: c.status, priority: c.priority, user_name: c.user_name, user_email: c.user_email, last_message: String(c.last_message || '').slice(0, 200), last_message_at: c.last_message_at || c.updated_date, last_sender: c.last_sender, unread: !!c.unread_admin }));
    const tickets = (await listTickets(env)).map(t => ({ ...t, message: String(t.message || '').slice(0, 300) }));
    return out({ ok: true, chats, tickets });
  }
  if (action === 'chat_get') {
    const s = await db.get('ChatSession', String(body.id || '')).catch(() => null);
    if (!s) throw new HttpError(404, 'not_found');
    const msgs = (await db.list('ChatMessage', { session_id: s.id }, { limit: 500 })).sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)));
    if (s.unread_admin) await db.update('ChatSession', s.id, { unread_admin: false }).catch(() => {});
    return out({ ok: true, session: s, messages: msgs.map(m => ({ id: m.id, sender: m.sender, author_name: m.author_name, content: m.content, attachments: m.attachments || [], created_date: m.created_date })) });
  }
  if (action === 'chat_reply') {
    const s = await db.get('ChatSession', String(body.id || '')).catch(() => null);
    if (!s) throw new HttpError(404, 'not_found');
    const content = String(body.content || '').trim().slice(0, 5000);
    if (!content) throw new HttpError(400, 'params');
    await db.create('ChatMessage', { session_id: s.id, user_id: s.user_id, sender: 'admin', author_name: 'AutoLeitwerk Support', content });
    await db.update('ChatSession', s.id, { last_message: content.slice(0, 300), last_message_at: nowIso(), last_sender: 'admin', unread_user: true, unread_admin: false, status: s.status === 'offen' ? 'in_bearbeitung' : s.status });
    const q = d.mailSupportChat(env, { toAdmin: false, session: s, content, user: {}, attachments: [] }).catch(e => logError('ceo_chat_mail', e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(q);
    return out({ ok: true });
  }
  if (action === 'chat_status') {
    if (!['offen', 'in_bearbeitung', 'abgeschlossen'].includes(body.status)) throw new HttpError(400, 'params');
    await db.update('ChatSession', String(body.id || ''), { status: body.status });
    return out({ ok: true });
  }
  if (action === 'ticket_reply' || action === 'ticket_status') {
    const key = TICKET_PREFIX + String(body.id || '');
    if (!/^_tickets\/[0-9TZ:.-]+_[a-f0-9]{8}$/.test(key)) throw new HttpError(400, 'params');
    const t = await env.PHOTOS.get(key, { type: 'json' });
    if (!t) throw new HttpError(404, 'not_found');
    if (action === 'ticket_status') {
      if (!['offen', 'in_bearbeitung', 'erledigt'].includes(body.status)) throw new HttpError(400, 'params');
      t.status = body.status;
    } else {
      const msg = String(body.message || '').trim().slice(0, 5000);
      if (!msg) throw new HttpError(400, 'params');
      const r = await d.sendMail(env, null, {
        to: t.email, replyTo: d.SUPPORT_TO(env), subject: `Re: ${t.subject}`,
        html: d.mailHtml({ title: 'Antwort vom AutoLeitwerk-Support', intro: `<div style="white-space:pre-wrap;background:#f7f6fb;border-radius:10px;padding:12px 14px">${d.esc(msg)}</div></p><p style="font-size:13px;color:#6b6b88;margin:0 0 16px">Ihre Anfrage: „${d.esc(t.subject)}“`, footer: 'AutoLeitwerk · info@autoleitwerk.de' }),
      });
      if (!r.sent) throw new HttpError(502, 'mail_failed', { message: r.reason === 'no_email' ? 'Zu dieser Anfrage gibt es keine E-Mail-Adresse.' : 'Antwort konnte nicht gesendet werden.' });
      t.replies = [...(t.replies || []), { at: nowIso(), message: msg }];
      if (t.status === 'offen') t.status = 'in_bearbeitung';
    }
    await env.PHOTOS.put(key, JSON.stringify(t), { metadata: { status: t.status, subject: String(t.subject).slice(0, 80) } });
    return out({ ok: true, ticket: t });
  }
  if (action === 'ticket_get') {
    const key = TICKET_PREFIX + String(body.id || '');
    if (!/^_tickets\/[0-9TZ:.-]+_[a-f0-9]{8}$/.test(key)) throw new HttpError(400, 'params');
    const t = await env.PHOTOS.get(key, { type: 'json' });
    if (!t) throw new HttpError(404, 'not_found');
    return out({ ok: true, ticket: t });
  }

  /* ---------- Entwickler-Tools ---------- */
  if (action === 'dev') {
    const mon = await d.readMonitor(env);
    const backups = await d.listBackups(env).catch(() => []);
    const ceoSessions = (await env.PHOTOS.list({ prefix: SESS_PREFIX })).keys.length;
    return out({
      ok: true, status: await d.statusReport(env), monitor: mon, backups: backups.slice(0, 14),
      config: {
        base44: !!env.BASE44_TOKEN, app_id: env.BASE44_APP_ID || null, ki: !!env.AI, speicher: !!env.PHOTOS, email: !!env.RESEND_API_KEY,
        admin_key: String(env.ADMIN_KEY || '').trim().length >= 16, ceo_email: ceoEmail(env), mail_from: env.MAIL_FROM || 'AutoLeitwerk <noreply@autoleitwerk.de>',
        support_email: d.SUPPORT_TO(env), allowed_origins: env.ALLOWED_ORIGINS || '', ceo_sessions: ceoSessions, uptimerobot: !!env.UPTIMEROBOT_API_KEY,
      },
      errors: recentErrors.slice(0, 30), time: nowIso(),
    });
  }
  if (action === 'dev_run_checks') return out({ ok: true, result: await d.runChecks(env) });
  if (action === 'dev_backup_now') return out({ ok: true, result: await d.runBackup(env) });
  if (action === 'dev_clear_cache') { d.clearCache(); settingsCache = null; return out({ ok: true }); }
  if (action === 'dev_test_mail') {
    const r = await d.sendMail(env, null, { to: ceoEmail(env), subject: 'AutoLeitwerk: Test-Mail aus der CEO-Konsole', html: d.mailHtml({ title: 'Test-Mail', intro: `E-Mail-Versand funktioniert (${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}).` }) });
    return out({ ok: r.sent, reason: r.reason || null });
  }
  if (action === 'dev_logout_all') {
    const keys = (await env.PHOTOS.list({ prefix: SESS_PREFIX })).keys;
    for (const k of keys) if (k.name !== sKey) await env.PHOTOS.delete(k.name);
    sessCache.clear();
    return out({ ok: true, removed: Math.max(0, keys.length - 1) });
  }
  if (action === 'dev_backup_file' || action === 'dev_export') {
    let raw;
    let name;
    if (action === 'dev_backup_file') {
      name = String(body.name || '');
      if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) throw new HttpError(400, 'params');
      raw = await env.PHOTOS.get(d.BACKUP_PREFIX + name, { type: 'arrayBuffer' });
      if (!raw) throw new HttpError(404, 'not_found');
      name = `autoleitwerk-backup-${name}`;
    } else {
      raw = JSON.stringify(await d.exportAll(db), null, 1);
      name = `autoleitwerk-daten-${d.berlinToday()}.json`;
    }
    return new Response(raw, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, ...secHeaders } });
  }

  /* ---------- Externe Überwachung (UptimeRobot) ---------- */
  if (action === 'uptime') return out({ ok: true, ...(await uptimeRobot(env, !!body.refresh)) });

  /* ---------- Einstellungen ---------- */
  if (action === 'settings_save') {
    const cur = await readSettings(env);
    const next = {
      ...cur,
      maintenance: typeof body.maintenance === 'boolean' ? body.maintenance : cur.maintenance,
      maintenance_message: typeof body.maintenance_message === 'string' ? body.maintenance_message.trim().slice(0, 300) || DEFAULT_SETTINGS.maintenance_message : cur.maintenance_message,
      announcement: typeof body.announcement === 'string' ? body.announcement.trim().slice(0, 300) : cur.announcement,
      updated_at: nowIso(),
    };
    await env.PHOTOS.put(SETTINGS_KEY, JSON.stringify(next));
    settingsCache = { ts: Date.now(), v: next };
    return out({ ok: true, settings: next });
  }

  throw new HttpError(400, 'unknown_action');
}

/* UptimeRobot (API v2 getMonitors). Schlüssel als Secret UPTIMEROBOT_API_KEY (Read-Only-Key reicht).
 * Free-Plan erlaubt 10 Abfragen/Minute → Ergebnis 60 s zwischenspeichern. */
const UR_STATUS = { 0: ['paused', 'Pausiert'], 1: ['pending', 'Noch nicht geprüft'], 2: ['up', 'Online'], 8: ['down', 'Scheint down'], 9: ['down', 'Down'] };
const UR_LOG = { 1: 'Ausfall', 2: 'Wieder online', 98: 'Gestartet', 99: 'Pausiert' };
let urCache = null;
export async function uptimeRobot(env, refresh) {
  const key = String(env.UPTIMEROBOT_API_KEY || '').trim();
  if (!key) return { configured: false };
  if (!refresh && urCache && Date.now() - urCache.ts < 60_000) return urCache.v;
  const form = new URLSearchParams({ api_key: key, format: 'json', logs: '1', logs_limit: '10', response_times: '1', response_times_limit: '48', custom_uptime_ratios: '1-7-30', all_time_uptime_ratio: '1' });
  let j;
  try {
    const res = await fetch('https://api.uptimerobot.com/v2/getMonitors', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' }, body: form.toString() });
    j = await res.json().catch(() => null);
    if (!res.ok || !j) return { configured: true, error: `UptimeRobot antwortet nicht (HTTP ${res.status}).` };
  } catch (e) { return { configured: true, error: 'UptimeRobot nicht erreichbar.' }; }
  if (j.stat !== 'ok') return { configured: true, error: (j.error && (j.error.message || j.error.type)) ? `UptimeRobot: ${j.error.message || j.error.type}` : 'UptimeRobot-Fehler (API-Schlüssel prüfen).' };
  const ratios = r => String(r || '').split('-').map(x => (x === '' ? null : Number(x)));
  const monitors = (j.monitors || []).map(m => {
    const [d1, d7, d30] = ratios(m.custom_uptime_ratio);
    const st = UR_STATUS[m.status] || ['pending', 'Unbekannt'];
    return {
      id: m.id, name: m.friendly_name, url: m.url, interval_min: Math.round((Number(m.interval) || 0) / 60),
      status: st[0], status_label: st[1], uptime_1d: d1, uptime_7d: d7, uptime_30d: d30, uptime_all: m.all_time_uptime_ratio != null ? Number(m.all_time_uptime_ratio) : null,
      avg_response_ms: m.average_response_time != null ? Math.round(Number(m.average_response_time)) : null,
      response_times: (m.response_times || []).slice(0, 48).reverse().map(r => ({ t: (Number(r.datetime) || 0) * 1000, ms: Number(r.value) || 0 })),
      logs: (m.logs || []).slice(0, 10).map(l => ({ type: UR_LOG[l.type] || String(l.type), down: l.type === 1, at: new Date((Number(l.datetime) || 0) * 1000).toISOString(), duration_min: Math.round((Number(l.duration) || 0) / 60), reason: l.reason ? String(l.reason.detail || l.reason.code || '') : '' })),
    };
  });
  const v = { configured: true, fetched_at: new Date().toISOString(), monitors, all_up: monitors.length > 0 && monitors.every(m => m.status === 'up' || m.status === 'paused') };
  urCache = { ts: Date.now(), v };
  return v;
}

async function listTickets(env) {
  const keys = (await env.PHOTOS.list({ prefix: TICKET_PREFIX })).keys.sort((a, b) => b.name.localeCompare(a.name)).slice(0, 100);
  const rows = await Promise.all(keys.map(k => env.PHOTOS.get(k.name, { type: 'json' }).catch(() => null)));
  return rows.filter(Boolean);
}

// Support-Anfrage aus dem Dashboard zusätzlich speichern, damit sie in der CEO-Konsole bearbeitbar ist
export async function storeTicket(env, t) {
  if (!env.PHOTOS) return null;
  const a = new Uint8Array(4); crypto.getRandomValues(a);
  const id = `${new Date().toISOString()}_${[...a].map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const rec = { id, created_at: new Date().toISOString(), status: 'offen', source: t.source || 'Dashboard', subject: t.subject, message: t.message, name: t.name || '', email: t.email || '', workshop_code: t.workshop_code || '', replies: [] };
  await env.PHOTOS.put(TICKET_PREFIX + id, JSON.stringify(rec), { metadata: { status: 'offen', subject: String(t.subject).slice(0, 80) } });
  return rec;
}
