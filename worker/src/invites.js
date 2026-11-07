/**
 * Einladungscodes: Registrierung im Dashboard nur mit einem Code, den AutoLeitwerk vorher an die Werkstatt schickt.
 *
 * - inviteCreate / inviteList / inviteRevoke / workshopCreate: nur Plattform-Admins
 * - inviteCheck: öffentlich (vor der Registrierung), zeigt nur den Werkstattnamen
 * - inviteRedeem: angemeldeter Nutzer ohne Werkstatt löst den Code ein → User.workshop_code wird gesetzt
 *
 * Gespeichert wird nur der SHA-256 des Codes. Ist am Code eine E-Mail hinterlegt, muss das Konto genau diese Adresse haben.
 */
export const INVITE_FUNCTIONS = new Set(['inviteCheck', 'inviteRedeem', 'inviteCreate', 'inviteList', 'inviteRevoke', 'workshopCreate']);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = c => c.match(/.{1,4}/g).join('-');
const okEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const deDate = iso => new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

function randomCode(len) {
  const b = new Uint8Array(len); crypto.getRandomValues(b);
  return [...b].map(x => ALPHABET[x % ALPHABET.length]).join('');
}
function inviteState(inv, now = Date.now()) {
  if (inv.revoked) return 'widerrufen';
  if ((Number(inv.used_count) || 0) >= (Number(inv.max_uses) || 1)) return 'eingelöst';
  if (inv.expires_at && new Date(inv.expires_at).getTime() < now) return 'abgelaufen';
  return 'offen';
}
function publicInvite(inv) {
  return { id: inv.id, workshop_code: inv.workshop_code, email: inv.email || '', role_label: inv.role_label || 'mitarbeiter', code_hint: inv.code_hint || '',
    max_uses: Number(inv.max_uses) || 1, used_count: Number(inv.used_count) || 0, expires_at: inv.expires_at, sent_at: inv.sent_at || null,
    created_date: inv.created_date || null, created_by_name: inv.created_by_name || '', state: inviteState(inv), redemptions: Array.isArray(inv.redemptions) ? inv.redemptions : [] };
}

export async function handleInvite(name, body, c) {
  const { db, user, HttpError, sha256Hex, rateLimit, ip, sendMail, mailHtml, dashboardUrl, invalidate, onUserChanged } = c;
  const hashOf = async code => sha256Hex('al-invite:' + normCode(code));
  async function findInvite(code) {
    const n = normCode(code);
    if (n.length < 8 || n.length > 20) throw new HttpError(400, 'invalid_code', { message: 'Bitte den vollständigen Einladungscode eingeben.' });
    const rows = await db.list('WorkshopInvite', { code_hash: await hashOf(n) }, { limit: 2 });
    const inv = rows[0];
    if (!inv) throw new HttpError(404, 'invalid_code', { message: 'Dieser Einladungscode ist nicht gültig.' });
    const st = inviteState(inv);
    if (st === 'abgelaufen') throw new HttpError(410, 'expired', { message: 'Dieser Einladungscode ist abgelaufen. Bitte fordere bei AutoLeitwerk einen neuen an.' });
    if (st === 'widerrufen') throw new HttpError(410, 'revoked', { message: 'Dieser Einladungscode wurde zurückgezogen.' });
    if (st !== 'offen') throw new HttpError(410, 'used', { message: 'Dieser Einladungscode wurde schon verwendet.' });
    const ws = (await db.list('Workshop', { code: inv.workshop_code }, { limit: 1 }))[0];
    if (!ws || ws.is_active === false) throw new HttpError(403, 'workshop_disabled', { message: 'Die Werkstatt zu diesem Code ist nicht aktiv.' });
    return { inv, ws };
  }
  const needAdmin = () => { if (!user || user.role !== 'admin') throw new HttpError(403, 'forbidden'); };

  if (name === 'inviteCheck') {
    rateLimit('invchk:' + ip, 20, 60_000);
    const { inv, ws } = await findInvite(body.code);
    return { ok: true, workshop_name: ws.name || inv.workshop_code, role_label: inv.role_label || 'mitarbeiter', email: inv.email || '' };
  }

  if (name === 'inviteRedeem') {
    if (!user) throw new HttpError(401, 'unauthorized');
    rateLimit('invred:' + user.id, 10, 3600_000);
    const { inv, ws } = await findInvite(body.code);
    if (user.workshop_code && user.workshop_code !== inv.workshop_code) throw new HttpError(409, 'already_assigned', { message: 'Dein Konto gehört schon zu einer anderen Werkstatt.' });
    if (inv.email && String(inv.email).trim().toLowerCase() !== String(user.email || '').trim().toLowerCase()) {
      throw new HttpError(403, 'email_mismatch', { message: 'Dieser Code gilt nur für die E-Mail-Adresse, an die er geschickt wurde.' });
    }
    if (!user.workshop_code) await db.req('PUT', `/User/${encodeURIComponent(user.id)}`, { workshop_code: inv.workshop_code });
    const redemptions = (Array.isArray(inv.redemptions) ? inv.redemptions : []).concat([{ user_id: user.id, email: user.email || '', at: new Date().toISOString() }]).slice(-50);
    await db.update('WorkshopInvite', inv.id, { used_count: (Number(inv.used_count) || 0) + 1, redemptions });
    if ((inv.role_label || '') === 'inhaber' && ws.owner_user_id !== user.id) {
      await db.update('Workshop', ws.id, { owner_user_id: user.id }).catch(e => console.log('invite_owner_failed', String(e)));
    }
    invalidate('Workshop'); onUserChanged();
    return { ok: true, workshop_code: inv.workshop_code, workshop_name: ws.name || inv.workshop_code };
  }

  needAdmin();

  if (name === 'workshopCreate') {
    const wsName = String(body.name || '').trim().slice(0, 120);
    if (wsName.length < 2) throw new HttpError(400, 'params', { message: 'Bitte einen Werkstattnamen eingeben.' });
    const all = await db.list('Workshop', null, { limit: 1000 });
    let code;
    for (let i = 0; i < 20 && (!code || all.some(w => w.code === code)); i++) code = 'AL-' + randomCode(6);
    const trial = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const ws = await db.create('Workshop', { code, name: wsName, owner_user_id: user.id, is_active: true, subscription_status: 'trial', trial_ends_at: trial });
    invalidate('Workshop');
    return { ok: true, workshop: { id: ws.id, code, name: wsName, trial_ends_at: trial } };
  }

  if (name === 'inviteCreate') {
    const code = String(body.workshop_code || '').trim().toUpperCase();
    const ws = (await db.list('Workshop', { code }, { limit: 1 }))[0];
    if (!ws) throw new HttpError(404, 'unknown_workshop', { message: 'Werkstatt nicht gefunden.' });
    const email = String(body.email || '').trim().toLowerCase();
    if (email && !okEmail(email)) throw new HttpError(400, 'params', { message: 'Die E-Mail-Adresse ist ungültig.' });
    if (body.send && !email) throw new HttpError(400, 'params', { message: 'Zum Versenden bitte eine E-Mail-Adresse eingeben.' });
    const role = body.role_label === 'inhaber' ? 'inhaber' : 'mitarbeiter';
    const days = Math.min(60, Math.max(1, Number(body.valid_days) || 14));
    const maxUses = Math.min(20, Math.max(1, Number(body.max_uses) || 1));
    const raw = randomCode(12);
    const expires = new Date(Date.now() + days * 864e5).toISOString();
    const inv = await db.create('WorkshopInvite', { code_hash: await hashOf(raw), code_hint: raw.slice(-4), workshop_code: code, email, role_label: role,
      max_uses: maxUses, used_count: 0, expires_at: expires, revoked: false, created_by_name: user.name || user.email || '', redemptions: [] });
    const pretty = fmtCode(raw);
    const link = `${dashboardUrl}/register?code=${encodeURIComponent(pretty)}`;
    let sent = false, sendError = null;
    if (body.send) {
      const r = await sendMail({ to: email, code, subject: `Ihre Einladung zu AutoLeitwerk – ${ws.name}`,
        html: mailHtml({
          title: 'Willkommen bei AutoLeitwerk',
          intro: `Für <b>${esc(ws.name)}</b> ist ein Zugang zum AutoLeitwerk-Dashboard eingerichtet. Mit dem Einladungscode legen Sie Ihr Konto an – die Werkstatt wird dabei automatisch verknüpft.`,
          rows: [['Einladungscode', pretty], ['Gültig bis', deDate(expires)]],
          button: { label: 'Konto erstellen', href: link },
          footer: 'Der Code ist persönlich und gilt nur für diese E-Mail-Adresse. Fragen? Antworten Sie einfach auf diese E-Mail oder schreiben Sie an info@autoleitwerk.de.',
        }) });
      sent = !!(r && r.sent); sendError = sent ? null : (r && r.reason) || 'unbekannt';
      if (sent) await db.update('WorkshopInvite', inv.id, { sent_at: new Date().toISOString() }).catch(() => {});
    }
    return { ok: true, code: pretty, link, expires_at: expires, sent, send_error: sendError, invite: publicInvite({ ...inv, sent_at: sent ? new Date().toISOString() : null }) };
  }

  if (name === 'inviteList') {
    const q = body.workshop_code ? { workshop_code: String(body.workshop_code).toUpperCase() } : null;
    const rows = await db.list('WorkshopInvite', q, { limit: 500, sort: '-created_date' });
    return { ok: true, invites: rows.map(publicInvite) };
  }

  if (name === 'inviteRevoke') {
    const inv = await db.get('WorkshopInvite', String(body.id || '')).catch(() => null);
    if (!inv) throw new HttpError(404, 'not_found');
    await db.update('WorkshopInvite', inv.id, { revoked: true });
    return { ok: true };
  }
  throw new HttpError(404, 'unknown_function');
}
