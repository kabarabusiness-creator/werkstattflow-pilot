/**
 * Kleiner PDF-Erzeuger ohne Fremdbibliothek: A4, Schrift Helvetica / Helvetica-Bold (in jedem PDF-Leser
 * eingebaut), WinAnsi-Zeichensatz (Umlaute, ß, €). Der Text bleibt echter, durchsuchbarer Text.
 * Gleiche Eingabe ergibt byte-gleiche Datei (Datum kommt vom Aufrufer) – wichtig für Prüfwerte.
 */
// Zeichenbreiten (1/1000 der Schriftgröße) für die Codes 32–255, aus den Adobe-AFM-Dateien
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,0,333,1000,0,0,0,0,0,0,0,0,0,0,0,222,222,333,333,350,556,1000,0,0,0,0,0,0,0,0,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,0,500,1000,0,0,0,0,0,0,0,0,0,0,0,278,278,500,500,350,556,1000,0,0,0,0,0,0,0,0,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

const SPECIAL = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
export const A4 = { w: 595.28, h: 841.89 };

function codes(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str).replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (c >= 0xA0 && c <= 0xFF) out.push(c);
    else if (SPECIAL[ch] != null) out.push(SPECIAL[ch]);
    else out.push(63); // ?
  }
  return out;
}
function literal(cs) {
  let s = '(';
  for (const c of cs) {
    if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
    else if (c < 127) s += String.fromCharCode(c);
    else s += '\\' + c.toString(8).padStart(3, '0');
  }
  return s + ')';
}
const n = v => (Math.round(v * 100) / 100).toString();
const rgb = c => c.map(v => n(v)).join(' ');

export function textWidth(str, size, bold) {
  const t = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const c of codes(str)) w += t[c - 32] || 500;
  return (w * size) / 1000;
}

// Text auf maximale Breite umbrechen (an Leerzeichen, zu lange Wörter werden hart getrennt)
export function wrapText(str, maxWidth, size, bold) {
  const words = String(str == null ? '' : str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (textWidth(w, size, bold) > maxWidth) {
      let i = w.length; while (i > 1 && textWidth(w.slice(0, i), size, bold) > maxWidth) i--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, i)); w = w.slice(i);
    }
    const next = cur ? cur + ' ' + w : w;
    if (textWidth(next, size, bold) <= maxWidth) cur = next; else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export class Pdf {
  constructor(info = {}) { this.info = info; this.pages = []; this.addPage(); }
  addPage() { this.page = []; this.pages.push(this.page); return this.pages.length; }
  setPage(i) { this.page = this.pages[i]; }
  // y wird von oben gemessen (Punkte), x von links
  text(str, x, y, o = {}) {
    const size = o.size || 10, bold = !!o.bold;
    let px = x;
    if (o.align === 'right') px = x - textWidth(str, size, bold);
    else if (o.align === 'center') px = x - textWidth(str, size, bold) / 2;
    this.page.push(`BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${rgb(o.color || [0.1, 0.1, 0.15])} rg ${n(px)} ${n(A4.h - y)} Td ${literal(codes(str))} Tj ET`);
  }
  rect(x, y, w, h, o = {}) {
    this.page.push(`${rgb(o.fill || [0.95, 0.95, 0.97])} rg ${n(x)} ${n(A4.h - y - h)} ${n(w)} ${n(h)} re f`);
  }
  line(x1, y1, x2, y2, o = {}) {
    this.page.push(`${rgb(o.color || [0.8, 0.8, 0.85])} RG ${n(o.width || 0.6)} w ${n(x1)} ${n(A4.h - y1)} m ${n(x2)} ${n(A4.h - y2)} l S`);
  }
  output() {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
    const d = this.info.date ? new Date(this.info.date) : new Date(0);
    const pdfDate = 'D:' + d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    const info = add(`<< /Title ${literal(codes(this.info.title || ''))} /Author ${literal(codes(this.info.author || ''))} /Producer (AutoLeitwerk) /CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>`);
    let out = '%PDF-1.4\n'; // alle Bytes sind ASCII (Sonderzeichen als Oktal-Escape)
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
