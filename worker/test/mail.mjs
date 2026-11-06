// Test des E-Mail-Postfachs gegen echte lokale IMAP- (hoodiecrow) und SMTP-Server (smtp-server).
// Einmalig: cd worker && npm i   ·   Aufruf: node worker/test/mail.mjs
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');
const { SMTPServer } = require('smtp-server');
const W = new URL('../src/', import.meta.url).href;
const { handleMail, setMailConnect, _internal } = await import(W + 'mail.js');
const PostalMime = (await import(W + 'vendor/postal-mime/postal-mime.js')).default;

const ok = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
const USER = 'werkstatt@example.test'; const PASS = 'Gehe1m!Pässwort';

// ---------- Nachrichten ----------
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const m1 = ['From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <juergen@kunde.test>', 'To: werkstatt@example.test', 'Subject: =?UTF-8?B?QnJlbXNlIHF1aWV0c2NodCAtIEdyw7bDn2UgMTcgWm9sbA==?=', 'Date: Thu, 05 Nov 2026 09:12:00 +0100', 'Message-ID: <m1@kunde.test>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'Hallo, meine Bremse quietscht seit Montag. K=C3=B6nnen Sie mir einen Termin geben?', 'Gru=C3=9F J=C3=BCrgen', ''].join('\r\n');
const m2 = ['From: Teilehandel Süd <rechnung@teile.test>', 'To: werkstatt@example.test', 'Subject: Ihre Rechnung RG-4711', 'Date: Thu, 05 Nov 2026 11:00:00 +0100', 'Message-ID: <m2@teile.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="XX"', '', '--XX', 'Content-Type: multipart/alternative; boundary="YY"', '', '--YY', 'Content-Type: text/plain; charset=utf-8', '', 'Anbei Ihre Rechnung über 595,00 EUR.', '--YY', 'Content-Type: text/html; charset=utf-8', '', '<p>Anbei Ihre <b>Rechnung</b> über 595,00 EUR.</p><img src="https://tracker.test/p.gif"><script>alert(1)</script>', '--YY--', '--XX', 'Content-Type: application/pdf; name="RG-4711.pdf"', 'Content-Disposition: attachment; filename="RG-4711.pdf"', 'Content-Transfer-Encoding: base64', '', PDF.toString('base64'), '--XX--', ''].join('\r\n');
const m3 = ['From: info@verband.test', 'To: werkstatt@example.test', 'Subject: =?ISO-8859-1?Q?Pr=FCfstand_Schulung?=', 'Date: Wed, 04 Nov 2026 08:00:00 +0100', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'Neue Termine f=FCr die Pr=FCfstand-Schulung.', ''].join('\r\n');
const m4 = ['From: Newsletter <news@shop.test>', 'To: werkstatt@example.test', 'Subject: Logo inline', 'Date: Tue, 03 Nov 2026 08:00:00 +0100', 'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="RR"', '', '--RR', 'Content-Type: text/html; charset=utf-8', '', '<html><body><p>Hallo</p><img src="cid:logo@x"></body></html>', '--RR', 'Content-Type: image/png', 'Content-ID: <logo@x>', 'Content-Transfer-Encoding: base64', '', PNG.toString('base64'), '--RR--', ''].join('\r\n');
const bin = s => Buffer.from(s, 'utf8').toString('binary');

function storage() {
  return {
    INBOX: { messages: [m3, m4, m1, m2].map(raw => ({ raw: bin(raw), flags: [] })) },
    '': {
      separator: '/',
      folders: {
        Gesendet: { 'special-use': '\\Sent' },
        'Entw&APw-rfe': { 'special-use': '\\Drafts' },
        Papierkorb: { 'special-use': '\\Trash' },
        Spam: { 'special-use': '\\Junk' },
        Archiv: {},
        Kunden: {},
      },
    },
  };
}

// ---------- Server ----------
const received = [];
function startImap(port, opts) {
  return new Promise(res => {
    const srv = hoodiecrow({ plugins: opts.plugins, secureConnection: opts.secure, storage: storage(), users: { [USER]: { password: PASS } } });
    srv.listen(port, () => res(srv));
  });
}
function startSmtp(port, secure, creds) {
  return new Promise(res => {
    const srv = new SMTPServer({
      secure, key: creds.key, cert: creds.cert, logger: false, authMethods: ['PLAIN', 'LOGIN'],
      onAuth(auth, s, done) { if (auth.username === USER && auth.password === PASS) done(null, { user: USER }); else done(new Error('Invalid credentials')); },
      onData(stream, session, done) { const ch = []; stream.on('data', c => ch.push(c)); stream.on('end', () => { received.push({ raw: Buffer.concat(ch), rcpt: session.envelope.rcptTo.map(r => r.address), from: session.envelope.mailFrom.address }); done(); }); },
    });
    srv.listen(port, () => res(srv));
  });
}
const imap1 = await startImap(19931, { secure: true, plugins: ['SPECIAL-USE', 'MOVE', 'UIDPLUS', 'LITERALPLUS', 'AUTH-PLAIN', 'SASL-IR'] });
const imap2 = await startImap(19143, { secure: false, plugins: ['SPECIAL-USE', 'STARTTLS', 'AUTH-PLAIN'] });
const creds = imap1.getCredentials();
const smtp1 = await startSmtp(19465, true, creds);
const smtp2 = await startSmtp(19587, false, creds);
const ROUTES = { 'imap.example.test:993': 19931, 'imap.example.test:143': 19143, 'smtp.example.test:465': 19465, 'smtp.example.test:587': 19587 };

// ---------- Socket-Adapter wie cloudflare:sockets ----------
function wrap(raw, evt) {
  let ctrl; const onData = d => { try { ctrl.enqueue(new Uint8Array(d)); } catch { /* */ } };
  const readable = new ReadableStream({ start(c) { ctrl = c; raw.on('data', onData); raw.once('end', () => { try { c.close(); } catch { /* */ } }); raw.once('error', e => { try { c.error(e); } catch { /* */ } }); } });
  const writable = new WritableStream({ write(chunk) { return new Promise((res, rej) => raw.write(Buffer.from(chunk), e => (e ? rej(e) : res()))); } });
  const opened = new Promise((res, rej) => { raw.once(evt, res); raw.once('error', rej); });
  return { readable, writable, opened, close: async () => raw.destroy(), startTls: () => { raw.off('data', onData); raw.removeAllListeners('end'); return wrap(tls.connect({ socket: raw, rejectUnauthorized: false }), 'secureConnect'); } };
}
setMailConnect(({ hostname, port }, { secureTransport }) => {
  const p = ROUTES[`${hostname}:${port}`];
  if (!p) { const s = net.connect({ host: '127.0.0.1', port: 1 }); return wrap(s, 'connect'); }
  const raw = secureTransport === 'on' ? tls.connect({ host: '127.0.0.1', port: p, rejectUnauthorized: false }) : net.connect({ host: '127.0.0.1', port: p });
  return wrap(raw, secureTransport === 'on' ? 'secureConnect' : 'connect');
});

// ---------- Worker-Umgebung ----------
class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra || {}; } }
const kv = new Map();
const PHOTOS = { async get(k, o) { const v = kv.get(k); return v == null ? null : o && o.type === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } };
const env = { PHOTOS, ADMIN_KEY: 'x'.repeat(32) };
const db = { list: async (e, f) => (e === 'Workshop' ? [{ code: 'AL-T1', name: 'Testwerkstatt', owner_user_id: 'u1' }] : []) };
const stored = [];
const ctx = user => ({ env, db, user, code: 'AL-T1', h: { HttpError, rateLimit: () => {} }, storeReceipt: async x => { stored.push(x); return { file_url: 'kv:_rcpt/AL-T1/x.pdf', file_name: x.filename }; } });
const owner = { id: 'u1', role: 'user', email: 'chef@werkstatt.test' };
const staff = { id: 'u2', role: 'user', email: 'buero@werkstatt.test' };
const call = (n, b, u = owner) => handleMail(n, b, ctx(u));
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

async function run(label, conn) {
  console.log(`\n=== ${label} ===`);
  kv.clear(); received.length = 0;
  let r = await call('mailStatus', {});
  ok(r.connected === false && r.can_manage === true, 'nicht verbunden, Inhaber darf verbinden');
  const e1 = await err(call('mailConnect', { ...conn, password: 'falsch' }));
  ok(e1 && e1.code === 'mail_auth' && /abgelehnt/.test(e1.extra.message), 'falsches Passwort: ' + (e1 && e1.extra.message));
  const e2 = await err(call('mailConnect', { ...conn, imap_host: '127.0.0.1' }));
  ok(e2 && e2.status === 400, 'IP-Adresse als Server abgelehnt');
  const e3 = await err(call('mailConnect', { ...conn, password: PASS }, staff));
  ok(e3 && e3.status === 403, 'Mitarbeiter darf nicht verbinden');
  r = await call('mailConnect', { ...conn, password: PASS, display_name: 'Testwerkstatt Müller', signature: 'Viele Grüße' });
  ok(r.connected && r.config.email === USER && !('secret' in r.config), 'verbunden, Passwort nicht in Antwort');
  const raw = kv.get('_mail/AL-T1/cfg');
  ok(raw && !raw.includes(PASS) && JSON.parse(raw).secret.ct, 'Passwort verschlüsselt gespeichert');
  r = await call('mailConnect', { ...conn, password: '', display_name: 'Testwerkstatt Müller', signature: 'Neu' });
  ok(r.connected && r.config.signature === 'Neu', 'Einstellungen ändern ohne erneutes Passwort');

  r = await call('mailStatus', { fresh: true });
  ok(r.unread === 4, 'ungelesen: ' + r.unread + (r.error ? ' ' + JSON.stringify(r.error) : ''));
  r = await call('mailStatus', {}, staff);
  ok(r.can_use && !r.can_manage, 'Mitarbeiter sieht geteiltes Postfach');

  r = await call('mailFolders', {});
  const roles = Object.fromEntries(r.folders.map(f => [f.role || f.name, f.path]));
  ok(roles.inbox === 'INBOX' && roles.sent === 'Gesendet' && roles.drafts === 'Entw&APw-rfe' && roles.trash === 'Papierkorb' && roles.spam === 'Spam' && roles.archive === 'Archiv', 'Ordner erkannt: ' + r.folders.map(f => `${f.label}(${f.role || '-'})`).join(', '));
  ok(r.folders.find(f => f.role === 'drafts').label === 'Entwürfe' && r.folders[0].count === 4, 'Bezeichnungen + Zähler');

  r = await call('mailList', { folder: 'INBOX' });
  ok(r.total === 4 && r.messages.length === 4, 'Liste: ' + r.messages.length);
  const bySub = Object.fromEntries(r.messages.map(m => [m.subject, m]));
  const brem = bySub['Bremse quietscht - Größe 17 Zoll'];
  ok(brem && brem.from.name === 'Jürgen Müller' && brem.from.email === 'juergen@kunde.test', 'Betreff/Absender dekodiert');
  ok(brem && /Können Sie mir einen Termin/.test(brem.snippet), 'Vorschau QP/UTF-8: ' + (brem && brem.snippet));
  ok(bySub['Prüfstand Schulung'] && /für die Prüfstand/.test(bySub['Prüfstand Schulung'].snippet), 'ISO-8859-1: ' + (bySub['Prüfstand Schulung'] || {}).snippet);
  const rg = bySub['Ihre Rechnung RG-4711'];
  ok(rg && rg.attachments && /Anbei Ihre Rechnung über 595,00/.test(rg.snippet) && rg.from.name === 'Teilehandel Süd', 'Multipart-Vorschau + Anhang-Kennung: ' + (rg && rg.snippet));
  ok(r.messages[0].subject === 'Ihre Rechnung RG-4711', 'neueste zuerst');

  r = await call('mailList', { folder: 'INBOX', q: 'quietscht' });
  ok(r.messages.length === 1 && r.messages[0].uid === brem.uid, 'Suche ASCII');
  r = await call('mailList', { folder: 'INBOX', q: 'Prüfstand' });
  ok(Array.isArray(r.messages), 'Suche mit Umlaut läuft (CHARSET UTF-8 + Literal; Testserver dekodiert QP-Text nicht)');
  r = await call('mailList', { folder: 'INBOX', filter: 'unread' });
  ok(r.messages.length === 4, 'Filter ungelesen');

  r = await call('mailMessage', { folder: 'INBOX', uid: rg.uid });
  ok(r.subject === 'Ihre Rechnung RG-4711' && /<b>Rechnung<\/b>/.test(r.html) && r.has_remote_images, 'Nachricht gelesen, externe Bilder erkannt');
  ok(r.attachments.length === 1 && r.attachments[0].filename === 'RG-4711.pdf' && r.attachments[0].content_type === 'application/pdf', 'Anhang gelistet');
  const att = await call('mailAttachment', { folder: 'INBOX', uid: rg.uid, index: r.attachments[0].index });
  ok(Buffer.from(att.data_base64, 'base64').equals(PDF), 'Anhang identisch');
  const rc = await call('mailAttachmentToReceipt', { folder: 'INBOX', uid: rg.uid, index: 0 });
  ok(rc.file_url && stored.at(-1).contentType === 'application/pdf' && Buffer.from(stored.at(-1).bytes).equals(PDF), 'Anhang als Beleg übernommen');
  const logo = (await call('mailList', { folder: 'INBOX' })).messages.find(m => m.subject === 'Logo inline');
  r = await call('mailMessage', { folder: 'INBOX', uid: logo.uid });
  ok(/src="data:image\/png;base64,/.test(r.html) && r.attachments.length === 0, 'Inline-Bild eingebettet');
  r = await call('mailStatus', { fresh: true });
  ok(r.unread === 2, 'gelesen markiert: ungelesen ' + r.unread);

  await call('mailFlag', { folder: 'INBOX', uids: [brem.uid], flagged: true, seen: true });
  r = await call('mailList', { folder: 'INBOX', filter: 'flagged' });
  ok(r.messages.length === 1 && r.messages[0].flagged && r.messages[0].seen, 'markiert + gelesen');
  await call('mailFlag', { folder: 'INBOX', uids: [brem.uid], seen: false });

  r = await call('mailMove', { folder: 'INBOX', uids: [logo.uid], to: 'archive' });
  ok(r.to === 'Archiv', 'ins Archiv verschoben');
  r = await call('mailList', { folder: 'Archiv' });
  ok(r.messages.length === 1 && r.messages[0].subject === 'Logo inline', 'liegt im Archiv');
  r = await call('mailMove', { folder: 'Archiv', uids: [r.messages[0].uid], to: 'trash' });
  ok(r.to === 'Papierkorb', 'in Papierkorb');
  const t = await call('mailList', { folder: 'Papierkorb' });
  r = await call('mailMove', { folder: 'Papierkorb', uids: [t.messages[0].uid], to: 'trash' });
  ok(r.deleted === true && (await call('mailList', { folder: 'Papierkorb' })).total === 0, 'endgültig gelöscht');

  // Entwurf, dann Antwort senden
  r = await call('mailDraft', { to: 'juergen@kunde.test', subject: 'AW: Bremse quietscht', text: 'Entwurf' });
  const drafts = await call('mailList', { folder: 'Entw&APw-rfe' });
  ok(drafts.total === 1 && drafts.messages[0].draft, 'Entwurf gespeichert');
  const draftUid = r.draft_uid || drafts.messages[0].uid;
  r = await call('mailSend', {
    to: [{ name: 'Jürgen Müller', email: 'juergen@kunde.test' }], cc: 'kollege@werkstatt.test', bcc: 'archiv@werkstatt.test',
    subject: 'AW: Bremse quietscht – Größe 17 Zoll', text: 'Hallo Herr Müller,\n\ngern am Montag um 9:00 Uhr.\n.\nGrüße\n\n> Hallo, meine Bremse quietscht',
    in_reply_to: '<m1@kunde.test>', references: '<m1@kunde.test>', reply_uid: brem.uid, reply_folder: 'INBOX', draft_uid: draftUid,
    attachments: [{ filename: 'Kostenvoranschlag Müller.pdf', content_type: 'application/pdf', data_base64: PDF.toString('base64') }],
  });
  ok(r.ok && r.message_id, 'gesendet');
  ok(received.length === 1 && received[0].rcpt.sort().join() === 'archiv@werkstatt.test,juergen@kunde.test,kollege@werkstatt.test' && received[0].from === USER, 'SMTP-Umschlag: ' + (received[0] && received[0].rcpt.join(',')));
  const p = await PostalMime.parse(received[0].raw);
  ok(p.subject === 'AW: Bremse quietscht – Größe 17 Zoll' && p.from.name === 'Testwerkstatt Müller', 'Betreff + Absendername kodiert: ' + p.subject + ' / ' + (p.from && p.from.name));
  ok(/gern am Montag um 9:00 Uhr\.\n\.\nGrüße/.test(p.text) && /<br>/.test(p.html), 'Text inkl. Punkt-Zeile + HTML');
  ok(p.attachments.length === 1 && p.attachments[0].filename === 'Kostenvoranschlag Müller.pdf' && Buffer.from(p.attachments[0].content).equals(PDF), 'Anhang mit Umlaut-Dateiname');
  ok(p.inReplyTo === '<m1@kunde.test>' && !/^Bcc:/mi.test(received[0].raw.toString()), 'In-Reply-To gesetzt, kein Bcc-Header beim Versand');
  r = await call('mailList', { folder: 'Gesendet' });
  ok(r.total === 1 && r.messages[0].subject.startsWith('AW: Bremse'), 'Kopie in Gesendet');
  ok((await call('mailList', { folder: 'Entw&APw-rfe' })).total === 0, 'Entwurf nach Versand entfernt');
  r = await call('mailList', { folder: 'INBOX', q: 'quietscht' });
  ok(r.messages[0].answered, 'Original als beantwortet markiert');

  const e4 = await err(call('mailSend', { to: 'kein-empfaenger', subject: 'x', text: 'y' }));
  ok(e4 && e4.status === 400, 'ungültiger Empfänger abgelehnt');

  // privat: Mitarbeiter ausgesperrt
  await call('mailConnect', { ...conn, password: '', display_name: 'Testwerkstatt Müller', private: true });
  r = await call('mailStatus', {}, staff);
  ok(r.can_use === false, 'privates Postfach für Mitarbeiter gesperrt');
  const e5 = await err(call('mailList', { folder: 'INBOX' }, staff));
  ok(e5 && e5.status === 403, 'Liste für Mitarbeiter 403');
  r = await call('mailDisconnect', {});
  ok(!kv.has('_mail/AL-T1/cfg'), 'getrennt, Zugangsdaten gelöscht');
}

await run('IMAPS 993 + SMTPS 465 (MOVE, UIDPLUS, LITERAL+)', { email: USER, imap_host: 'imap.example.test', imap_port: 993, smtp_host: 'smtp.example.test', smtp_port: 465 });
await run('IMAP 143 STARTTLS + SMTP 587 STARTTLS (ohne MOVE/UIDPLUS)', { email: USER, imap_host: 'imap.example.test', imap_port: 143, smtp_host: 'smtp.example.test', smtp_port: 587 });

// Einheiten
const { qpEncode, encodeWord, classifyFolders } = _internal;
ok(qpEncode('a'.repeat(80) + ' \nZeile mit Ümlaut =').split('\r\n').every(l => l.length <= 76), 'QP-Zeilenlänge');
ok(/^=\?UTF-8\?B\?/.test(encodeWord('Größe')), 'encoded word');
const gm = classifyFolders([{ path: 'INBOX', delim: '/', flags: [] }, { path: '[Gmail]/Alle Nachrichten', delim: '/', flags: ['\\All'] }, { path: '[Gmail]/Gesendet', delim: '/', flags: ['\\Sent'] }]);
ok(gm.find(f => f.role === 'all').archiveTarget, 'Gmail: Alle Nachrichten als Archiv');

imap1.close?.(); imap2.close?.(); smtp1.close(); smtp2.close();
setTimeout(() => process.exit(process.exitCode || 0), 300);
