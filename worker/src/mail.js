/**
 * E-Mail-Postfach der Werkstatt im Dashboard: lesen über IMAP, senden über SMTP.
 * Der Worker spricht direkt mit dem Mailserver der Werkstatt (TCP über cloudflare:sockets) –
 * kein Fremddienst dazwischen. Funktioniert mit Gmail (App-Passwort), IONOS, Strato, GMX, WEB.DE,
 * T-Online und jedem anderen Anbieter mit IMAP/SMTP.
 *
 * Zugangsdaten: AES-GCM verschlüsselt in KV (_mail/<CODE>/cfg). Schlüssel aus MAIL_KEY,
 * sonst abgeleitet aus ADMIN_KEY. Das Passwort geht nie zurück an den Browser.
 */
import PostalMime, { addressParser, decodeWords } from './vendor/postal-mime/postal-mime.js';
import { getDecoder } from './vendor/postal-mime/decode-strings.js';

export const MAIL_FUNCTIONS = new Set(['mailStatus', 'mailConnect', 'mailDisconnect', 'mailFolders', 'mailList', 'mailMessage', 'mailAttachment', 'mailAttachmentToReceipt', 'mailFlag', 'mailMove', 'mailSend', 'mailDraft']);

const te = new TextEncoder();
const utf8 = new TextDecoder('utf-8');
const PAGE_SIZE = 30;
const MAX_MESSAGE = 25 * 1024 * 1024;
const MAX_SEND_ATTACH = 18 * 1024 * 1024;
const IMAP_PORTS = new Set([993, 143]);
const SMTP_PORTS = new Set([465, 587, 2525]);
const unreadCache = new Map();

class MailError extends Error {
  constructor(kind, message, detail) { super(message || kind); this.kind = kind; this.detail = detail || ''; }
}

/* ---------- TCP (in Tests austauschbar) ---------- */
let connectImpl = null;
export function setMailConnect(fn) { connectImpl = fn; }
async function tcp(host, port, secureTransport) {
  const connect = connectImpl || (await import('cloudflare:sockets')).connect;
  const sock = connect({ hostname: host, port }, { secureTransport, allowHalfOpen: false });
  await withTimeout(sock.opened, 15000, () => new MailError('connect', `Server ${host}:${port} nicht erreichbar.`));
  return sock;
}
function withTimeout(p, ms, err) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(err()), ms); })]).finally(() => clearTimeout(t));
}

// Byte-Strom mit Zeilen- und Literal-Lesen ohne quadratisches Kopieren
class Stream {
  constructor(sock) { this.sock = sock; this.r = sock.readable.getReader(); this.w = sock.writable.getWriter(); this.buf = new Uint8Array(0); this.pos = 0; }
  async chunk() {
    const { value, done } = await withTimeout(this.r.read(), 30000, () => new MailError('timeout', 'Der Mailserver antwortet nicht.'));
    if (done || !value) throw new MailError('closed', 'Verbindung vom Mailserver getrennt.');
    return value instanceof Uint8Array ? value : new Uint8Array(value);
  }
  async more() {
    const v = await this.chunk();
    const rest = this.buf.length - this.pos;
    if (!rest) { this.buf = v; this.pos = 0; return; }
    const nb = new Uint8Array(rest + v.length); nb.set(this.buf.subarray(this.pos)); nb.set(v, rest); this.buf = nb; this.pos = 0;
  }
  async line() {
    for (;;) {
      const i = this.buf.indexOf(10, this.pos);
      if (i >= 0) { const end = i > this.pos && this.buf[i - 1] === 13 ? i - 1 : i; const b = this.buf.subarray(this.pos, end); this.pos = i + 1; return b; }
      if (this.buf.length - this.pos > 2_000_000) throw new MailError('protocol', 'Ungültige Antwort vom Mailserver.');
      await this.more();
    }
  }
  async bytes(n) {
    const out = new Uint8Array(n);
    let got = Math.min(n, this.buf.length - this.pos);
    out.set(this.buf.subarray(this.pos, this.pos + got)); this.pos += got;
    while (got < n) {
      const v = await this.chunk();
      const take = Math.min(n - got, v.length);
      out.set(v.subarray(0, take), got); got += take;
      if (take < v.length) { this.buf = v.subarray(take); this.pos = 0; }
    }
    return out;
  }
  async write(d) { await this.w.write(typeof d === 'string' ? te.encode(d) : d); }
  release() { try { this.r.releaseLock(); } catch { /* */ } try { this.w.releaseLock(); } catch { /* */ } }
  async close() { this.release(); try { await this.sock.close(); } catch { /* */ } }
}

/* ---------- IMAP ---------- */
const quote = s => '"' + String(s).replace(/[\\"]/g, m => '\\' + m) + '"';
const needsLiteral = s => /[^\x20-\x7e]/.test(s) || s.length > 900;
const astr = s => (needsLiteral(String(s)) ? { lit: te.encode(String(s)) } : quote(s));

// Antwort in Tokens zerlegen: Atome (string), {q: quoted}, Literale (Uint8Array), Listen (Array)
function tokenize(segs) {
  const root = []; const stack = [root];
  const top = () => stack[stack.length - 1];
  for (const seg of segs) {
    if (seg instanceof Uint8Array) { top().push(seg); continue; }
    const s = seg; let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') { i++; continue; }
      if (c === '(') { const l = []; top().push(l); stack.push(l); i++; continue; }
      if (c === ')') { if (stack.length > 1) stack.pop(); i++; continue; }
      if (c === '"') {
        let j = i + 1; let out = '';
        while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) j++; out += s[j]; j++; }
        top().push({ q: out }); i = j + 1; continue;
      }
      if (c === '{' && /^\{\d+\+?\}$/.test(s.slice(i))) break; // Literal folgt als eigenes Segment
      let j = i; let depth = 0;
      while (j < s.length) {
        const d = s[j];
        if (d === '[') depth++;
        else if (d === ']') depth = Math.max(0, depth - 1);
        else if (depth === 0 && (d === ' ' || d === '(' || d === ')')) break;
        j++;
      }
      top().push(s.slice(i, j)); i = j;
    }
  }
  return root;
}
const tokStr = t => (t == null ? null : t instanceof Uint8Array ? utf8.decode(t) : typeof t === 'object' && 'q' in t ? t.q : t === 'NIL' ? null : String(t));
const tokBytes = t => (t instanceof Uint8Array ? t : t && typeof t === 'object' && 'q' in t ? te.encode(t.q) : null);

class Imap {
  constructor(s, host) { this.s = s; this.host = host; this.n = 0; this.caps = new Set(); }

  static async open(cfg, pass) {
    const starttls = cfg.imap_security === 'starttls';
    let sock = await tcp(cfg.imap_host, cfg.imap_port, starttls ? 'starttls' : 'on');
    let imap = new Imap(new Stream(sock), cfg.imap_host);
    const greet = await imap.read();
    if (greet.tag !== '*' || !/^\* (OK|PREAUTH)/i.test(greet.text)) throw new MailError('connect', 'Unerwartete Antwort vom IMAP-Server.');
    imap.capsFrom(greet.text);
    if (starttls) {
      await imap.cmd('STARTTLS');
      imap.s.release();
      sock = sock.startTls({ expectedServerHostname: cfg.imap_host });
      imap = new Imap(new Stream(sock), cfg.imap_host);
    }
    if (!imap.caps.size || starttls) { imap.caps.clear(); (await imap.cmd('CAPABILITY')).forEach(r => imap.capsFrom(r.text)); }
    const user = cfg.login_user || cfg.email;
    try {
      if (imap.caps.has('AUTH=PLAIN')) {
        // AUTHENTICATE PLAIN: funktioniert auch mit Umlauten im Passwort
        const token = b64bytes(te.encode(`\u0000${user}\u0000${pass}`));
        if (imap.caps.has('SASL-IR')) await imap.cmd(`AUTHENTICATE PLAIN ${token}`);
        else await imap.cmd(['AUTHENTICATE PLAIN', { cont: token }]);
      } else await imap.cmd(['LOGIN ', astr(user), ' ', astr(pass)]);
    } catch (e) {
      await imap.s.close();
      if (e.kind === 'no' || e.kind === 'bad') throw new MailError('auth', 'Anmeldung am Postfach abgelehnt.', e.message);
      throw e;
    }
    const caps = await imap.cmd('CAPABILITY');
    caps.forEach(r => imap.capsFrom(r.text));
    return imap;
  }

  capsFrom(text) {
    const m = /CAPABILITY ([^\]]*)/i.exec(text || '');
    if (m) m[1].trim().split(/\s+/).forEach(c => this.caps.add(c.toUpperCase()));
  }

  // eine vollständige Antwort lesen (mit eingebetteten Literalen)
  async read() {
    const segs = [];
    for (;;) {
      const lineBytes = await this.s.line();
      const line = utf8.decode(lineBytes);
      segs.push(line);
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) break;
      const n = Number(m[1]);
      if (n > MAX_MESSAGE + 1_000_000) throw new MailError('too_large', 'Nachricht ist zu groß.');
      segs.push(await this.s.bytes(n));
    }
    const first = segs[0];
    if (first.startsWith('+')) return { cont: true, text: first };
    const sp = first.indexOf(' ');
    const tag = first.slice(0, sp);
    const rest = first.slice(sp + 1);
    if (tag === '*') return { tag, text: first, segs };
    const sp2 = rest.indexOf(' ');
    return { tag, status: (sp2 < 0 ? rest : rest.slice(0, sp2)).toUpperCase(), text: sp2 < 0 ? '' : rest.slice(sp2 + 1), segs };
  }

  async cmd(parts) {
    const tag = 'A' + (++this.n);
    const arr = Array.isArray(parts) ? parts : [parts];
    const out = [];
    let buf = tag + ' ';
    for (const p of arr) {
      if (typeof p === 'string') { buf += p; continue; }
      if (p.cont != null) {
        await this.s.write(buf + '\r\n'); buf = '';
        for (;;) { const r = await this.read(); if (r.cont) break; if (r.tag === tag) throw new MailError(r.status === 'NO' ? 'no' : 'bad', r.text); out.push(r); }
        await this.s.write(p.cont + '\r\n');
        return this.finish(tag, arr, out);
      }
      const plus = this.caps.has('LITERAL+') || (this.caps.has('LITERAL-') && p.lit.length <= 4096);
      await this.s.write(buf + `{${p.lit.length}${plus ? '+' : ''}}\r\n`); buf = '';
      if (!plus) {
        for (;;) {
          const r = await this.read();
          if (r.cont) break;
          if (r.tag === tag) throw new MailError(r.status === 'NO' ? 'no' : 'bad', r.text);
          out.push(r);
        }
      }
      await this.s.write(p.lit);
    }
    await this.s.write(buf + '\r\n');
    return this.finish(tag, arr, out);
  }

  async finish(tag, arr, out) {
    for (;;) {
      const r = await this.read();
      if (r.cont) continue;
      if (r.tag === '*') { if (/^\* BYE/i.test(r.text) && !/^LOGOUT/i.test(String(arr[0]))) throw new MailError('closed', 'Der Mailserver hat die Verbindung beendet.'); out.push(r); continue; }
      if (r.tag !== tag) continue;
      if (r.status !== 'OK') throw new MailError(r.status === 'NO' ? 'no' : 'bad', r.text || r.status);
      out.ok = r.text;
      return out;
    }
  }

  async logout() {
    try { await withTimeout(this.cmd('LOGOUT'), 3000, () => new MailError('timeout')); } catch { /* egal */ }
    await this.s.close();
  }

  async folders() {
    const res = await this.cmd('LIST "" "*"');
    const list = [];
    for (const r of res) {
      const t = tokenize(r.segs);
      if (String(t[1]).toUpperCase() !== 'LIST') continue;
      const flags = (Array.isArray(t[2]) ? t[2] : []).map(f => String(f));
      const delim = tokStr(t[3]) || '/';
      const path = tokStr(t[4]);
      if (path == null) continue;
      const lower = flags.map(f => f.toLowerCase());
      if (lower.includes('\\noselect') || lower.includes('\\nonexistent')) continue;
      list.push({ path, delim, flags });
    }
    return classifyFolders(list);
  }

  async select(path, readOnly) {
    const res = await this.cmd([readOnly ? 'EXAMINE ' : 'SELECT ', astr(path)]);
    let exists = 0;
    for (const r of res) { const m = /^\* (\d+) EXISTS/i.exec(r.text); if (m) exists = Number(m[1]); }
    return { exists };
  }

  async fetch(set, items, uid = true) {
    const res = await this.cmd(`${uid ? 'UID ' : ''}FETCH ${set} ${items}`);
    const out = [];
    for (const r of res) {
      if (!/^\* \d+ FETCH/i.test(r.text)) continue;
      const t = tokenize(r.segs);
      const l = Array.isArray(t[3]) ? t[3] : [];
      const map = {};
      for (let i = 0; i + 1 < l.length; i += 2) {
        let k = String(l[i]).toUpperCase();
        if (k.startsWith('BODY[HEADER')) k = 'HEADER';
        else if (k.startsWith('BODY[TEXT]')) k = 'TEXT';
        else if (k.startsWith('BODY[]')) k = 'RAW';
        map[k] = l[i + 1];
      }
      map.SEQ = Number(t[1]);
      out.push(map);
    }
    return out;
  }

  async search(criteria) {
    const res = await this.cmd(['UID SEARCH ', ...criteria]);
    const uids = [];
    for (const r of res) { const m = /^\* SEARCH ?(.*)$/i.exec(r.text); if (m) m[1].trim().split(/\s+/).filter(Boolean).forEach(x => uids.push(Number(x))); }
    return uids.filter(Number.isFinite).sort((a, b) => a - b);
  }

  async expunge(uids) {
    if (this.caps.has('UIDPLUS')) await this.cmd(`UID EXPUNGE ${uids.join(',')}`);
    else await this.cmd('EXPUNGE');
  }

  async moveUids(uids, dest) {
    const set = uids.join(',');
    if (this.caps.has('MOVE')) { await this.cmd([`UID MOVE ${set} `, astr(dest)]); return; }
    await this.cmd([`UID COPY ${set} `, astr(dest)]);
    await this.cmd(`UID STORE ${set} +FLAGS.SILENT (\\Deleted)`);
    await this.expunge(uids);
  }

  async append(path, flags, raw) {
    const res = await this.cmd(['APPEND ', astr(path), ` (${flags.join(' ')}) `, { lit: raw }]);
    const m = /APPENDUID \d+ (\d+)/i.exec(res.ok || '');
    return m ? Number(m[1]) : null;
  }
}

/* ---------- Ordner erkennen ---------- */
const ROLE_FLAGS = { '\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'spam', '\\archive': 'archive', '\\all': 'all' };
const ROLE_NAMES = {
  sent: ['sent', 'sent items', 'sent messages', 'sent mail', 'gesendet', 'gesendete objekte', 'gesendete elemente', 'gesendete nachrichten', 'gesendete e-mails'],
  drafts: ['drafts', 'draft', 'entwürfe', 'entwurf'],
  trash: ['trash', 'papierkorb', 'gelöscht', 'gelöschte objekte', 'gelöschte elemente', 'gelöschte nachrichten', 'deleted', 'deleted items', 'deleted messages', 'bin'],
  spam: ['spam', 'junk', 'junk-e-mail', 'junk e-mail', 'spamverdacht', 'unerwünscht'],
  archive: ['archive', 'archiv'],
};
export function decodeMutf7(s) {
  return String(s).replace(/&([^-]*)-/g, (m, b) => {
    if (!b) return '&';
    try {
      const b64s = b.replace(/,/g, '/'); const pad = (4 - (b64s.length % 4)) % 4;
      const bin = atob(b64s + '='.repeat(pad)); let out = '';
      for (let i = 0; i + 1 < bin.length; i += 2) out += String.fromCharCode((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
      return out;
    } catch { return m; }
  });
}
const ROLE_LABEL = { inbox: 'Eingang', drafts: 'Entwürfe', sent: 'Gesendet', archive: 'Archiv', spam: 'Spam', trash: 'Papierkorb', all: 'Alle Nachrichten' };
const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'all', 'spam', 'trash'];
function classifyFolders(list) {
  const taken = new Set();
  const out = list.map(f => {
    const parts = f.path.split(f.delim || '/');
    const leaf = decodeMutf7(parts[parts.length - 1]);
    let role = f.path.toUpperCase() === 'INBOX' ? 'inbox' : null;
    if (!role) for (const fl of f.flags) { const r = ROLE_FLAGS[fl.toLowerCase()]; if (r) { role = r; break; } }
    return { path: f.path, name: decodeMutf7(f.path).split(f.delim || '/').filter(Boolean).join(' / '), leaf, role, flagged: !!role };
  });
  out.forEach(f => { if (f.role) taken.add(f.role); });
  for (const [role, names] of Object.entries(ROLE_NAMES)) {
    if (taken.has(role)) continue;
    const hit = out.find(f => !f.role && names.includes(f.leaf.toLowerCase().replace(/^inbox[./]/, '')));
    if (hit) { hit.role = role; taken.add(role); }
  }
  // Gmail: „Alle Nachrichten“ dient als Archiv, wenn es kein eigenes Archiv gibt
  if (!taken.has('archive')) { const all = out.find(f => f.role === 'all'); if (all) all.archiveTarget = true; }
  out.forEach(f => { f.label = f.role && ROLE_LABEL[f.role] ? ROLE_LABEL[f.role] : f.name; });
  return out.sort((a, b) => {
    const ra = a.role ? ROLE_ORDER.indexOf(a.role) : 99; const rb = b.role ? ROLE_ORDER.indexOf(b.role) : 99;
    return ra - rb || a.name.localeCompare(b.name, 'de');
  }).map(({ flagged, ...f }) => f);
}
function roleFolder(folders, role) {
  if (role === 'archive') return folders.find(f => f.role === 'archive') || folders.find(f => f.archiveTarget) || null;
  return folders.find(f => f.role === role) || null;
}

/* ---------- Kopfzeilen und Vorschau für die Liste ---------- */
function parseHeaders(bytes) {
  const text = utf8.decode(bytes || new Uint8Array(0)).replace(/\r?\n[ \t]+/g, ' ');
  const h = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in h)) h[k] = line.slice(i + 1).trim();
  }
  return h;
}
const dw = s => { try { return decodeWords(s || ''); } catch { return s || ''; } };
function addrs(s) {
  if (!s) return [];
  try {
    const flat = [];
    const walk = l => l.forEach(a => (a.group ? walk(a.group) : flat.push({ name: dw(a.name || ''), email: (a.address || '').trim() })));
    walk(addressParser(s));
    return flat.filter(a => a.email || a.name).slice(0, 100);
  } catch { return [{ name: dw(s), email: '' }]; }
}
function ctParams(ct) {
  const p = {}; const parts = String(ct || '').split(';');
  p._type = (parts.shift() || '').trim().toLowerCase();
  for (const x of parts) { const i = x.indexOf('='); if (i > 0) p[x.slice(0, i).trim().toLowerCase()] = x.slice(i + 1).trim().replace(/^"|"$/g, ''); }
  return p;
}
function decodeQP(s) { return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))); }
function latin1Bytes(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
function decodeBody(raw, cte, charset) {
  let bin = raw;
  cte = String(cte || '').toLowerCase();
  if (cte === 'base64') { const clean = raw.replace(/[^A-Za-z0-9+/]/g, ''); try { bin = atob(clean.slice(0, clean.length - (clean.length % 4))); } catch { bin = ''; } } else if (cte === 'quoted-printable') bin = decodeQP(raw);
  try { return getDecoder(charset || 'utf-8').decode(latin1Bytes(bin)); } catch { return bin; }
}
const stripHtml = s => s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&[a-z]+;/gi, ' ');
// Vorschau aus den ersten Bytes der Nachricht (ohne vollständiges MIME-Parsen – schont die CPU)
function snippet(headers, textBytes) {
  const raw = textBytes ? Array.from(textBytes, b => String.fromCharCode(b)).join('') : '';
  const ct = ctParams(headers['content-type'] || 'text/plain');
  let body = ''; let html = ct._type === 'text/html';
  if (ct._type.startsWith('multipart/') && ct.boundary) {
    const parts = raw.split('--' + ct.boundary);
    let pick = null;
    const scan = (chunks, depth) => {
      for (const part of chunks) {
        const i = part.search(/\r?\n\r?\n/); if (i < 0) continue;
        const ph = parseHeaders(latin1Bytes(part.slice(0, i)));
        const pct = ctParams(ph['content-type'] || 'text/plain');
        const content = part.slice(i).replace(/^\r?\n\r?\n/, '');
        if (pct._type.startsWith('multipart/') && pct.boundary && depth < 3) { scan(content.split('--' + pct.boundary), depth + 1); if (pick && pick.type === 'text/plain') return; continue; }
        if (/attachment/i.test(ph['content-disposition'] || '')) continue;
        if (pct._type === 'text/plain' && (!pick || pick.type !== 'text/plain')) { pick = { type: 'text/plain', content, cte: ph['content-transfer-encoding'], charset: pct.charset }; return; }
        if (pct._type === 'text/html' && !pick) pick = { type: 'text/html', content, cte: ph['content-transfer-encoding'], charset: pct.charset };
      }
    };
    scan(parts.slice(1), 0);
    if (pick) { body = decodeBody(pick.content, pick.cte, pick.charset); html = pick.type === 'text/html'; }
  } else body = decodeBody(raw, headers['content-transfer-encoding'], ct.charset);
  if (html) body = stripHtml(body);
  return body.replace(/\s+/g, ' ').trim().slice(0, 180);
}
function imapDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/^(\d{1,2})-(\w{3})-(\d{4})/, '$1 $2 $3'));
  return isNaN(d) ? null : d.toISOString();
}
function headerDate(s, fallback) {
  const d = s ? new Date(String(s).replace(/\s*\([^)]*\)\s*$/, '')) : null;
  return d && !isNaN(d) ? d.toISOString() : imapDate(fallback);
}
function listItem(m) {
  const h = parseHeaders(tokBytes(m.HEADER));
  const flags = (Array.isArray(m.FLAGS) ? m.FLAGS : []).map(String);
  const ct = ctParams(h['content-type']);
  return {
    uid: Number(m.UID), seq: m.SEQ,
    from: addrs(h.from)[0] || null, to: addrs(h.to), cc: addrs(h.cc),
    subject: dw(h.subject || ''), date: headerDate(h.date, tokStr(m.INTERNALDATE)),
    seen: flags.includes('\\Seen'), flagged: flags.includes('\\Flagged'), answered: flags.includes('\\Answered'), draft: flags.includes('\\Draft'),
    size: Number(m['RFC822.SIZE']) || 0,
    attachments: ct._type === 'multipart/mixed' || ct._type === 'application/pdf',
    snippet: snippet(h, tokBytes(m.TEXT)),
  };
}

/* ---------- Nachricht erzeugen (MIME) ---------- */
const b64bytes = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const wrap76 = s => s.replace(/(.{76})/g, '$1\r\n');
const isAscii = s => /^[\x20-\x7e]*$/.test(s);
function encodeWord(s) {
  s = String(s || '');
  if (isAscii(s)) return s;
  const chunks = []; let cur = '';
  for (const ch of s) { if (te.encode(cur + ch).length > 45) { chunks.push(cur); cur = ch; } else cur += ch; }
  if (cur) chunks.push(cur);
  return chunks.map(c => `=?UTF-8?B?${b64bytes(te.encode(c))}?=`).join('\r\n ');
}
function fmtAddr(a) {
  const email = String(a.email || '').trim();
  const name = String(a.name || '').replace(/[\r\n"]/g, '').trim();
  if (!name) return email;
  return `${isAscii(name) ? (/[(),.:;<>@[\\\]]/.test(name) ? `"${name}"` : name) : encodeWord(name)} <${email}>`;
}
function qpEncode(str) {
  const bytes = te.encode(String(str).replace(/\r?\n/g, '\r\n'));
  let out = ''; let line = '';
  const hex = b => '=' + b.toString(16).toUpperCase().padStart(2, '0');
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13 && bytes[i + 1] === 10) {
      if (line.endsWith(' ')) line = line.slice(0, -1) + '=20'; else if (line.endsWith('\t')) line = line.slice(0, -1) + '=09';
      out += line + '\r\n'; line = ''; i++; continue;
    }
    let enc = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9 ? String.fromCharCode(b) : hex(b);
    if (line.length + enc.length > 75) { out += line + '=\r\n'; line = ''; }
    if (!line.length && enc === '.') enc = '=2E';
    line += enc;
  }
  if (line.endsWith(' ')) line = line.slice(0, -1) + '=20';
  return out + line;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function textToHtml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const body = lines.map(l => {
    const linked = esc(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
    return /^&gt;/.test(esc(l)) ? `<span style="color:#6b7280">${linked}</span>` : linked;
  }).join('<br>\r\n');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${body}</div></body></html>`;
}
const boundary = () => '=_al_' + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
function filenameParams(name) {
  const n = String(name || 'anhang').replace(/[\r\n"\\/]/g, '_').slice(0, 150);
  if (isAscii(n)) return { ct: `; name="${n}"`, cd: `; filename="${n}"` };
  return { ct: `; name="${encodeWord(n).replace(/\r\n /g, '')}"`, cd: `; filename*=UTF-8''${encodeURIComponent(n).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}` };
}
export function buildMessage(o) {
  const date = o.date || new Date();
  const domain = String(o.from.email).split('@')[1] || 'autoleitwerk.de';
  const messageId = o.messageId || `<${Date.now().toString(36)}.${boundary().slice(5, 21)}@${domain}>`;
  const hdr = [
    `From: ${fmtAddr(o.from)}`,
    o.to && o.to.length ? `To: ${o.to.map(fmtAddr).join(',\r\n ')}` : null,
    o.cc && o.cc.length ? `Cc: ${o.cc.map(fmtAddr).join(',\r\n ')}` : null,
    o.withBcc && o.bcc && o.bcc.length ? `Bcc: ${o.bcc.map(fmtAddr).join(',\r\n ')}` : null,
    o.replyTo ? `Reply-To: ${fmtAddr(o.replyTo)}` : null,
    `Subject: ${encodeWord(o.subject || '')}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}` : null,
    o.references ? `References: ${String(o.references).slice(0, 2000)}` : null,
    'MIME-Version: 1.0',
    'X-Mailer: AutoLeitwerk',
  ].filter(Boolean);
  const alt = boundary();
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qpEncode(o.text || ''),
    `--${alt}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qpEncode(o.html || textToHtml(o.text)),
    `--${alt}--`, '',
  ].join('\r\n');
  let body;
  if (o.attachments && o.attachments.length) {
    const mix = boundary();
    const parts = o.attachments.map(a => {
      const fp = filenameParams(a.filename);
      return [`--${mix}`, `Content-Type: ${a.contentType || 'application/octet-stream'}${fp.ct}`, `Content-Disposition: attachment${fp.cd}`, 'Content-Transfer-Encoding: base64', '', wrap76(a.base64)].join('\r\n');
    });
    body = [`Content-Type: multipart/mixed; boundary="${mix}"`, '', `--${mix}`, altPart, ...parts, `--${mix}--`, ''].join('\r\n');
  } else body = altPart;
  return { raw: hdr.join('\r\n') + '\r\n' + body, messageId };
}

/* ---------- SMTP ---------- */
async function smtpReply(s, okCodes) {
  const lines = [];
  for (;;) {
    const l = utf8.decode(await s.line());
    lines.push(l);
    if (l.length < 4 || l[3] !== '-') break;
  }
  const code = Number(lines[lines.length - 1].slice(0, 3));
  if (!okCodes.includes(code)) throw new MailError(code === 535 || code === 534 ? 'auth' : 'smtp', lines.map(l => l.slice(4)).join(' ').slice(0, 300), String(code));
  return lines.map(l => l.slice(4));
}
export async function smtpSend(cfg, pass, { from, rcpt, raw }) {
  const starttls = cfg.smtp_security === 'starttls';
  let sock = await tcp(cfg.smtp_host, cfg.smtp_port, starttls ? 'starttls' : 'on');
  let s = new Stream(sock);
  try {
    await smtpReply(s, [220]);
    const ehlo = async () => { await s.write('EHLO autoleitwerk.de\r\n'); return smtpReply(s, [250]); };
    let caps = await ehlo();
    if (starttls) {
      await s.write('STARTTLS\r\n'); await smtpReply(s, [220]);
      s.release();
      sock = sock.startTls({ expectedServerHostname: cfg.smtp_host });
      s = new Stream(sock);
      caps = await ehlo();
    }
    const authLine = caps.find(l => /^AUTH[ =]/i.test(l)) || 'AUTH PLAIN LOGIN';
    const user = cfg.login_user || cfg.email;
    const b = str => b64bytes(te.encode(str));
    if (/\bPLAIN\b/i.test(authLine)) {
      await s.write(`AUTH PLAIN ${b(`\u0000${user}\u0000${pass}`)}\r\n`);
      await smtpReply(s, [235]);
    } else {
      await s.write('AUTH LOGIN\r\n'); await smtpReply(s, [334]);
      await s.write(b(user) + '\r\n'); await smtpReply(s, [334]);
      await s.write(b(pass) + '\r\n'); await smtpReply(s, [235]);
    }
    if (!raw) { await s.write('QUIT\r\n'); return { ok: true }; }
    await s.write(`MAIL FROM:<${from}>\r\n`); await smtpReply(s, [250]);
    for (const r of rcpt) { await s.write(`RCPT TO:<${r}>\r\n`); await smtpReply(s, [250, 251]); }
    await s.write('DATA\r\n'); await smtpReply(s, [354]);
    const data = raw.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
    await s.write(data + (data.endsWith('\r\n') ? '' : '\r\n') + '.\r\n');
    await smtpReply(s, [250]);
    await s.write('QUIT\r\n');
    return { ok: true };
  } finally { await s.close(); }
}

/* ---------- Zugangsdaten verschlüsseln ---------- */
async function cryptoKey(env, kid) {
  const secret = kid === 'm1' ? env.MAIL_KEY : env.ADMIN_KEY;
  if (!secret) throw new MailError('config', 'Der E-Mail-Speicher ist noch nicht eingerichtet.');
  const base = await crypto.subtle.importKey('raw', te.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('autoleitwerk-mail'), info: te.encode('imap-credentials-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptPass(env, code, pass) {
  const kid = env.MAIL_KEY ? 'm1' : 'a1';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(code) }, await cryptoKey(env, kid), te.encode(pass));
  return { kid, iv: b64bytes(iv), ct: b64bytes(new Uint8Array(ct)) };
}
async function decryptPass(env, code, sec) {
  try {
    const iv = Uint8Array.from(atob(sec.iv), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(sec.ct), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(code) }, await cryptoKey(env, sec.kid), ct);
    return utf8.decode(pt);
  } catch (e) {
    if (e instanceof MailError) throw e;
    throw new MailError('auth', 'Gespeicherte Zugangsdaten sind nicht mehr lesbar. Bitte das Postfach neu verbinden.');
  }
}

/* ---------- Hilfen ---------- */
const HOST_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const isGmail = host => /(^|\.)(gmail|googlemail)\.com$/i.test(host);
const cfgKey = code => `_mail/${code}/cfg`;
function cleanList(v, max = 50) {
  const arr = (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map(x => (typeof x === 'object' && x ? x : { email: String(x) }))
    .map(a => ({ name: String(a.name || '').slice(0, 120), email: String(a.email || '').trim().replace(/^.*<([^>]+)>.*$/, '$1').trim() }))
    .filter(a => a.email);
  if (arr.length > max) throw new MailError('params', `Höchstens ${max} Empfänger.`);
  const bad = arr.find(a => !EMAIL_RE.test(a.email));
  if (bad) throw new MailError('params', `Ungültige E-Mail-Adresse: ${bad.email}`);
  return arr;
}
const uidList = v => { const a = (Array.isArray(v) ? v : [v]).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 500); if (!a.length) throw new MailError('params', 'Keine Nachricht ausgewählt.'); return a; };
function mailErrorText(e) {
  if (e.kind === 'auth') return e.message + (e.detail ? '' : '');
  return e.message;
}

/* ---------- Funktionen ---------- */
export async function handleMail(name, body, c) {
  const { env, db, user, code, h } = c;
  const { HttpError, rateLimit } = h;
  if (!env.PHOTOS) throw new HttpError(503, 'not_available', { message: 'Speicher ist noch nicht eingerichtet.' });
  const ws = (await db.list('Workshop', { code }, { limit: 1 }).catch(() => []))[0] || null;
  const raw = await env.PHOTOS.get(cfgKey(code), { type: 'json' }).catch(() => null);
  const cfg = raw && raw.v ? raw : null;
  const canManage = !!(user.role === 'admin' || !ws || !ws.owner_user_id || ws.owner_user_id === user.id || (cfg && cfg.owner_user_id === user.id));
  const canUse = !!cfg && (!cfg.private || cfg.owner_user_id === user.id || user.role === 'admin');
  const fail = e => {
    if (e instanceof MailError) {
      const status = { auth: 401, params: 400, too_large: 413, config: 503 }[e.kind] || 502;
      const msg = e.kind === 'auth' ? `${e.message}${/gmail|googlemail/i.test((cfg && cfg.imap_host) || body.imap_host || '') ? ' Bei Gmail brauchen Sie ein App-Passwort (Google-Konto → Sicherheit → App-Passwörter).' : ' Bitte E-Mail-Adresse, Benutzername und Passwort prüfen.'}` : mailErrorText(e);
      // nie 401 zurückgeben – das Dashboard würde das als „abgemeldet“ deuten
      throw new HttpError(status === 401 ? 400 : status, 'mail_' + e.kind, { message: msg });
    }
    throw e;
  };
  const publicCfg = x => ({ email: x.email, display_name: x.display_name || '', login_user: x.login_user || '', imap_host: x.imap_host, imap_port: x.imap_port, imap_security: x.imap_security, smtp_host: x.smtp_host, smtp_port: x.smtp_port, smtp_security: x.smtp_security, private: !!x.private, signature: x.signature || '', connected_at: x.connected_at, connected_by: x.connected_by || '' });

  if (name === 'mailStatus') {
    if (!cfg) return { ok: true, connected: false, can_manage: canManage };
    if (!canUse) return { ok: true, connected: true, can_use: false, can_manage: canManage, email: cfg.email };
    const hit = unreadCache.get(code);
    let unread = null; let error = null;
    if (hit && Date.now() - hit.ts < 60_000 && !body.fresh) ({ unread, error } = hit);
    else {
      let imap;
      try {
        imap = await Imap.open(cfg, await decryptPass(env, code, cfg.secret));
        const res = await imap.cmd('STATUS INBOX (UNSEEN)');
        for (const r of res) { const m = /UNSEEN (\d+)/i.exec(r.text); if (m) unread = Number(m[1]); }
      } catch (e) { error = e instanceof MailError ? { kind: e.kind, message: e.message } : { kind: 'error', message: 'Postfach nicht erreichbar.' }; } finally { if (imap) await imap.logout(); }
      unreadCache.set(code, { ts: Date.now(), unread, error });
    }
    return { ok: true, connected: true, can_use: true, can_manage: canManage, unread, error, config: publicCfg(cfg) };
  }

  if (name === 'mailConnect') {
    if (!canManage) throw new HttpError(403, 'forbidden', { message: 'Nur der Inhaber der Werkstatt kann das Postfach verbinden.' });
    rateLimit('mailconn:' + user.id, 15, 3600_000);
    const n = {
      v: 1,
      email: String(body.email || '').trim().toLowerCase(),
      display_name: String(body.display_name || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120),
      login_user: String(body.login_user || '').trim().slice(0, 200),
      imap_host: String(body.imap_host || '').trim().toLowerCase(), imap_port: Number(body.imap_port) || 993, imap_security: body.imap_security === 'starttls' ? 'starttls' : 'ssl',
      smtp_host: String(body.smtp_host || '').trim().toLowerCase(), smtp_port: Number(body.smtp_port) || 465, smtp_security: body.smtp_security === 'starttls' ? 'starttls' : 'ssl',
      private: !!body.private, signature: String(body.signature || '').slice(0, 2000),
    };
    if (!EMAIL_RE.test(n.email)) throw new HttpError(400, 'params', { message: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
    if (!HOST_RE.test(n.imap_host) || !HOST_RE.test(n.smtp_host)) throw new HttpError(400, 'params', { message: 'Bitte gültige Servernamen eingeben (z. B. imap.ionos.de).' });
    if (!IMAP_PORTS.has(n.imap_port)) throw new HttpError(400, 'params', { message: 'IMAP-Port bitte 993 (SSL) oder 143 (STARTTLS).' });
    if (!SMTP_PORTS.has(n.smtp_port)) throw new HttpError(400, 'params', { message: 'SMTP-Port bitte 465 (SSL) oder 587 (STARTTLS).' });
    if (n.imap_port === 143) n.imap_security = 'starttls';
    if (n.smtp_port === 587 || n.smtp_port === 2525) n.smtp_security = 'starttls';
    if (n.imap_port === 993) n.imap_security = 'ssl';
    if (n.smtp_port === 465) n.smtp_security = 'ssl';
    const sameServer = cfg && cfg.email === n.email && cfg.imap_host === n.imap_host && (cfg.login_user || '') === n.login_user;
    let pass = String(body.password || '');
    if (!pass && sameServer) pass = await decryptPass(env, code, cfg.secret).catch(() => '');
    if (!pass) throw new HttpError(400, 'params', { message: 'Bitte das Passwort eingeben.' });
    if (pass.length > 500) throw new HttpError(400, 'params', { message: 'Passwort ist zu lang.' });
    let imap;
    try {
      imap = await Imap.open(n, pass);
      await imap.folders();
    } catch (e) { fail(e); } finally { if (imap) await imap.logout(); }
    try { await smtpSend(n, pass, {}); } catch (e) {
      if (e instanceof MailError) throw new HttpError(400, 'mail_smtp', { message: `Empfangen klappt, aber der Versand-Server (SMTP) lehnt ab: ${e.message}` });
      throw e;
    }
    const saved = { ...n, secret: await encryptPass(env, code, pass), owner_user_id: cfg && sameServer ? cfg.owner_user_id : user.id, connected_by: user.email || user.name || '', connected_at: cfg && sameServer ? cfg.connected_at : new Date().toISOString(), updated_at: new Date().toISOString() };
    await env.PHOTOS.put(cfgKey(code), JSON.stringify(saved));
    unreadCache.delete(code);
    return { ok: true, connected: true, config: publicCfg(saved) };
  }

  if (name === 'mailDisconnect') {
    if (!canManage) throw new HttpError(403, 'forbidden', { message: 'Nur der Inhaber der Werkstatt kann das Postfach trennen.' });
    await env.PHOTOS.delete(cfgKey(code));
    unreadCache.delete(code);
    return { ok: true, connected: false };
  }

  if (!cfg) throw new HttpError(404, 'mail_not_connected', { message: 'Es ist noch kein Postfach verbunden.' });
  if (!canUse) throw new HttpError(403, 'forbidden', { message: 'Dieses Postfach ist privat.' });
  rateLimit('mail:' + user.id, 1500, 3600_000);
  const pass = await decryptPass(env, code, cfg.secret).catch(fail);
  const folderArg = () => { const f = String(body.folder || 'INBOX'); if (!f || f.length > 500 || /[\r\n]/.test(f)) throw new HttpError(400, 'params'); return f; };

  // Versand zuerst (SMTP), danach Ablage im IMAP-Postfach
  if (name === 'mailSend') {
    rateLimit('mailsend:' + code, 150, 3600_000);
    let to, cc, bcc;
    try { to = cleanList(body.to); cc = cleanList(body.cc); bcc = cleanList(body.bcc); } catch (e) { fail(e); }
    if (!to.length && !cc.length && !bcc.length) throw new HttpError(400, 'params', { message: 'Bitte mindestens einen Empfänger angeben.' });
    const atts = checkAttachments(body.attachments, HttpError);
    const msg = {
      from: { name: cfg.display_name || (ws && ws.name) || '', email: cfg.email }, to, cc, bcc,
      subject: String(body.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300), text: String(body.text || '').slice(0, 300_000),
      inReplyTo: /^<[^<>\s]{3,300}>$/.test(body.in_reply_to || '') ? body.in_reply_to : null,
      references: String(body.references || '').split(/\s+/).filter(r => /^<[^<>\s]{3,300}>$/.test(r)).slice(-20).join(' ') || null,
      attachments: atts,
    };
    const built = buildMessage(msg);
    try { await smtpSend(cfg, pass, { from: cfg.email, rcpt: [...to, ...cc, ...bcc].map(a => a.email), raw: built.raw }); } catch (e) { fail(e); }
    const stored = { sent_copy: false, warning: null };
    let imap;
    try {
      imap = await Imap.open(cfg, pass);
      const folders = await imap.folders();
      const sent = roleFolder(folders, 'sent');
      if (sent && !isGmail(cfg.imap_host)) { await imap.append(sent.path, ['\\Seen'], te.encode(buildMessage({ ...msg, messageId: built.messageId, withBcc: true }).raw)); stored.sent_copy = true; }
      if (body.reply_uid && body.reply_folder) { await imap.select(String(body.reply_folder)); await imap.cmd(`UID STORE ${Number(body.reply_uid)} +FLAGS.SILENT (\\Answered)`); }
      if (body.draft_uid) { const d = roleFolder(folders, 'drafts'); if (d) { await imap.select(d.path); await imap.cmd(`UID STORE ${Number(body.draft_uid)} +FLAGS.SILENT (\\Deleted)`); await imap.expunge([Number(body.draft_uid)]); } }
    } catch (e) { stored.warning = 'Gesendet, aber die Kopie im Ordner „Gesendet“ konnte nicht abgelegt werden.'; console.log('mail store', String(e && e.message)); } finally { if (imap) await imap.logout(); }
    return { ok: true, message_id: built.messageId, ...stored };
  }

  let imap;
  try {
    imap = await Imap.open(cfg, pass);

    if (name === 'mailFolders') {
      const folders = await imap.folders();
      const counts = {};
      for (const f of folders.filter(x => ['inbox', 'drafts', 'spam'].includes(x.role)).slice(0, 3)) {
        try { const res = await imap.cmd(['STATUS ', astr(f.path), f.role === 'drafts' ? ' (MESSAGES)' : ' (UNSEEN)']); for (const r of res) { const m = /(UNSEEN|MESSAGES) (\d+)/i.exec(r.text); if (m) counts[f.path] = Number(m[2]); } } catch { /* */ }
      }
      return { ok: true, folders: folders.map(f => ({ ...f, count: counts[f.path] ?? null })) };
    }

    if (name === 'mailList') {
      const folder = folderArg();
      const page = Math.max(0, Math.min(500, Number(body.page) || 0));
      const { exists } = await imap.select(folder, true);
      const items = '(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.1600>)';
      const q = String(body.q || '').replace(/[\r\n]/g, ' ').trim().slice(0, 100);
      const filter = ['unread', 'flagged', 'attachments'].includes(body.filter) ? body.filter : 'all';
      let rows = []; let total = exists;
      if (q || filter === 'unread' || filter === 'flagged') {
        const crits = [];
        if (filter === 'unread') crits.push(['UNSEEN']);
        if (filter === 'flagged') crits.push(['FLAGGED']);
        if (q) crits.push(['TEXT ', isAscii(q) ? quote(q) : { lit: te.encode(q) }]);
        const parts = q && !isAscii(q) ? ['CHARSET UTF-8 '] : [];
        crits.forEach((x, i) => { if (i) parts.push(' '); parts.push(...x); });
        const uids = await imap.search(parts);
        total = uids.length;
        const end = total - page * PAGE_SIZE; const start = Math.max(0, end - PAGE_SIZE);
        const pick = end > 0 ? uids.slice(start, end) : [];
        if (pick.length) rows = await imap.fetch(pick.join(','), items, true);
      } else if (exists > 0) {
        const hi = exists - page * PAGE_SIZE; const lo = Math.max(1, hi - PAGE_SIZE + 1);
        if (hi >= 1) rows = await imap.fetch(`${lo}:${hi}`, items, false);
      }
      let list = rows.map(listItem).sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.uid - a.uid);
      if (filter === 'attachments') list = list.filter(m => m.attachments);
      return { ok: true, folder, total, page, page_size: PAGE_SIZE, has_more: (page + 1) * PAGE_SIZE < total, messages: list };
    }

    if (name === 'mailMessage' || name === 'mailAttachment' || name === 'mailAttachmentToReceipt') {
      const folder = folderArg();
      const uid = uidList(body.uid)[0];
      await imap.select(folder, name !== 'mailMessage');
      const meta = await imap.fetch(String(uid), '(UID FLAGS RFC822.SIZE)');
      if (!meta.length) throw new HttpError(404, 'not_found', { message: 'Nachricht nicht gefunden (evtl. verschoben oder gelöscht).' });
      if (Number(meta[0]['RFC822.SIZE']) > MAX_MESSAGE) throw new HttpError(413, 'too_large', { message: 'Diese Nachricht ist zu groß für die Anzeige (über 25 MB).' });
      const res = await imap.fetch(String(uid), name === 'mailMessage' ? '(UID FLAGS BODY[])' : '(UID BODY.PEEK[])');
      const rawBytes = res.length ? tokBytes(res.find(r => r.RAW)?.RAW) : null;
      if (!rawBytes) throw new HttpError(404, 'not_found', { message: 'Nachricht nicht gefunden.' });
      const parsed = await PostalMime.parse(rawBytes);
      const atts = (parsed.attachments || []).map((a, i) => ({ a, i }));
      if (name !== 'mailMessage') {
        const hit = atts.find(x => x.i === Number(body.index));
        if (!hit) throw new HttpError(404, 'not_found', { message: 'Anhang nicht gefunden.' });
        const bytes = new Uint8Array(hit.a.content);
        if (name === 'mailAttachment') return { ok: true, filename: hit.a.filename || `anhang-${hit.i + 1}`, content_type: hit.a.mimeType || 'application/octet-stream', size: bytes.length, data_base64: b64bytes(bytes) };
        return { ok: true, ...(await c.storeReceipt({ bytes, contentType: String(hit.a.mimeType || '').toLowerCase(), filename: hit.a.filename || 'beleg', source: `E-Mail von ${(parsed.from && parsed.from.address) || ''}` })) };
      }
      let html = parsed.html || '';
      let inlineBytes = 0;
      const inlineUsed = new Set();
      if (html) {
        html = html.replace(/(["'(])cid:([^"')\s]+)/gi, (m, pre, cid) => {
          const hit = atts.find(x => x.a.contentId && x.a.contentId.replace(/^<|>$/g, '') === decodeURIComponent(cid));
          if (!hit) return m;
          const bytes = new Uint8Array(hit.a.content);
          if (inlineBytes + bytes.length > 6_000_000 || !/^image\//i.test(hit.a.mimeType || '')) return m;
          inlineBytes += bytes.length; inlineUsed.add(hit.i);
          return `${pre}data:${hit.a.mimeType};base64,${b64bytes(bytes)}`;
        });
      }
      const flags = (Array.isArray(meta[0].FLAGS) ? meta[0].FLAGS : []).map(String);
      unreadCache.delete(code);
      const one = a => (a ? { name: a.name || '', email: a.address || '' } : null);
      const many = l => (l || []).flatMap(a => (a.group ? a.group : [a])).map(one).filter(Boolean);
      return {
        ok: true, folder, uid,
        from: one(parsed.from), to: many(parsed.to), cc: many(parsed.cc), bcc: many(parsed.bcc), reply_to: many(parsed.replyTo),
        subject: parsed.subject || '', date: parsed.date ? new Date(parsed.date).toISOString() : null,
        message_id: parsed.messageId || null, in_reply_to: parsed.inReplyTo || null, references: parsed.references || null,
        flagged: flags.includes('\\Flagged'), answered: flags.includes('\\Answered'), draft: flags.includes('\\Draft'),
        text: (parsed.text || '').slice(0, 500_000), html: html.slice(0, 3_000_000), has_remote_images: /<img[^>]+src=["']?https?:/i.test(html) || /url\(\s*['"]?https?:/i.test(html),
        attachments: atts.filter(x => !inlineUsed.has(x.i)).map(x => ({ index: x.i, filename: x.a.filename || `Anhang ${x.i + 1}`, content_type: x.a.mimeType || 'application/octet-stream', size: x.a.content ? x.a.content.byteLength : 0 })),
      };
    }

    if (name === 'mailFlag') {
      const folder = folderArg(); const uids = uidList(body.uids);
      await imap.select(folder);
      const ops = [];
      if (typeof body.seen === 'boolean') ops.push(`${body.seen ? '+' : '-'}FLAGS.SILENT (\\Seen)`);
      if (typeof body.flagged === 'boolean') ops.push(`${body.flagged ? '+' : '-'}FLAGS.SILENT (\\Flagged)`);
      for (const op of ops) await imap.cmd(`UID STORE ${uids.join(',')} ${op}`);
      unreadCache.delete(code);
      return { ok: true };
    }

    if (name === 'mailMove') {
      const folder = folderArg(); const uids = uidList(body.uids);
      const folders = await imap.folders();
      const target = String(body.to || '');
      const dest = ['trash', 'archive', 'spam', 'inbox'].includes(target) ? roleFolder(folders, target) : folders.find(f => f.path === target);
      const src = folders.find(f => f.path === folder);
      await imap.select(folder);
      if (target === 'trash' && (!dest || (src && src.role === 'trash') || body.permanent === true)) {
        await imap.cmd(`UID STORE ${uids.join(',')} +FLAGS.SILENT (\\Deleted)`);
        await imap.expunge(uids);
        unreadCache.delete(code);
        return { ok: true, deleted: true };
      }
      if (!dest) throw new HttpError(400, 'params', { message: target === 'archive' ? 'Dieses Postfach hat keinen Archiv-Ordner.' : 'Zielordner nicht gefunden.' });
      if (dest.path === folder) return { ok: true };
      await imap.moveUids(uids, dest.path);
      unreadCache.delete(code);
      return { ok: true, to: dest.path };
    }

    if (name === 'mailDraft') {
      const folders = await imap.folders();
      const d = roleFolder(folders, 'drafts');
      if (!d) throw new HttpError(400, 'params', { message: 'Dieses Postfach hat keinen Entwürfe-Ordner.' });
      let to, cc, bcc;
      try { to = cleanList(body.to); cc = cleanList(body.cc); bcc = cleanList(body.bcc); } catch (e) { fail(e); }
      const atts = checkAttachments(body.attachments, HttpError);
      const built = buildMessage({ from: { name: cfg.display_name || (ws && ws.name) || '', email: cfg.email }, to, cc, bcc, withBcc: true, subject: String(body.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300), text: String(body.text || '').slice(0, 300_000), inReplyTo: /^<[^<>\s]{3,300}>$/.test(body.in_reply_to || '') ? body.in_reply_to : null, references: body.references || null, attachments: atts });
      const newUid = await imap.append(d.path, ['\\Draft', '\\Seen'], te.encode(built.raw));
      if (body.draft_uid) { await imap.select(d.path); await imap.cmd(`UID STORE ${Number(body.draft_uid)} +FLAGS.SILENT (\\Deleted)`); await imap.expunge([Number(body.draft_uid)]); }
      return { ok: true, draft_uid: newUid, folder: d.path };
    }
  } catch (e) { fail(e); } finally { if (imap) await imap.logout(); }
  throw new HttpError(404, 'unknown_function');
}

function checkAttachments(list, HttpError) {
  const atts = (Array.isArray(list) ? list : []).slice(0, 20).map(a => ({
    filename: String(a.filename || 'anhang').slice(0, 150),
    contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.content_type || '') ? a.content_type : 'application/octet-stream',
    base64: String(a.data_base64 || '').replace(/\s+/g, ''),
  }));
  let total = 0;
  for (const a of atts) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)) throw new HttpError(400, 'params', { message: `Anhang „${a.filename}“ ist beschädigt.` });
    total += Math.floor(a.base64.length * 3 / 4);
  }
  if (total > MAX_SEND_ATTACH) throw new HttpError(413, 'too_large', { message: 'Anhänge zusammen höchstens 18 MB.' });
  return atts;
}

// für Tests
export const _internal = { tokenize, classifyFolders, snippet, parseHeaders, qpEncode, encodeWord, Imap };
