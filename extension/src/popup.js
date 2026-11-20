import { alReadPage, alFillVehicle } from './page.js';
import { parseCart, parseMoney, round2, supplierFromHost, SUPPLIER_NAMES, TIRE_SUPPLIERS } from './cart.js';

const API = 'https://werkstattflow-pilot.werkstattflow.workers.dev/fn/';
const DASHBOARD = 'https://login.autoleitwerk.de';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => n == null || n === '' || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const st = { token: null, me: null, rows: [], orders: [], orderId: null, target: 'auftrag', ctx: null, tab: null, source: null, markup: 0, busy: false };

async function api(name, body) {
  const res = await fetch(API + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { await chrome.storage.local.remove(['token']); throw Object.assign(new Error(data.message || 'Nicht mehr verbunden – bitte im Dashboard neu verbinden.'), { auth: true }); }
  if (!res.ok) throw new Error(data.message || ({ module_disabled: 'Diese Funktion ist für Ihre Werkstatt nicht freigeschaltet.', maintenance: 'AutoLeitwerk wird gerade gewartet.' })[data.error] || 'Das hat nicht geklappt (' + (data.error || res.status) + ').');
  return data;
}
function say(text, kind) { const m = $('msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'msg ' + (kind || 'ok'); }

/* ---------- Positionen ---------- */
function vk(row) {
  if (row.sale_price != null && row.sale_price !== '') return parseMoney(row.sale_price);
  const ek = parseMoney(row.unit_price);
  return ek != null && st.markup ? round2(ek * (1 + st.markup / 100)) : null;
}
function renderRows() {
  const box = $('rows');
  if (!st.rows.length) {
    box.innerHTML = `<div class="empty">${st.source && st.source.mode === 'nichts' ? 'Auf dieser Seite wurde kein Warenkorb erkannt.<br>Tipp: Warenkorb-Zeilen markieren und Erweiterung erneut öffnen – oder unten Text einfügen.' : 'Keine Positionen.'}</div>`;
  } else {
    const showVk = st.target === 'auftrag';
    box.innerHTML = `<table><thead><tr><th>Menge</th><th>Bezeichnung / Teilenummer</th><th>EK €</th>${showVk ? '<th>VK €</th>' : ''}<th></th></tr></thead><tbody>${st.rows.map((r, i) => `
      <tr>
        <td class="q"><input class="num" data-i="${i}" data-k="quantity" value="${esc(r.quantity)}" inputmode="numeric" aria-label="Menge"></td>
        <td><input data-i="${i}" data-k="part_name" value="${esc(r.part_name)}" aria-label="Bezeichnung"><input class="sub" data-i="${i}" data-k="part_number" value="${esc(r.part_number)}" placeholder="Teilenummer" aria-label="Teilenummer"></td>
        <td class="p"><input class="num" data-i="${i}" data-k="unit_price" value="${esc(r.unit_price == null ? '' : eur(r.unit_price))}" inputmode="decimal" aria-label="Einkaufspreis"></td>
        ${showVk ? `<td class="p"><input class="num" data-i="${i}" data-k="sale_price" value="${esc(r.sale_price != null && r.sale_price !== '' ? r.sale_price : eur(vk(r)))}" placeholder="${st.markup ? '+' + st.markup + ' %' : ''}" inputmode="decimal" aria-label="Verkaufspreis"></td>` : ''}
        <td class="x"><button data-del="${i}" title="Zeile entfernen" aria-label="Zeile entfernen">×</button></td>
      </tr>`).join('')}</tbody></table>
      <div class="sum"><span>${st.rows.length} Position${st.rows.length === 1 ? '' : 'en'}</span><span>EK ${eur(st.rows.reduce((s, r) => s + (parseMoney(r.unit_price) || 0) * (Number(r.quantity) || 1), 0))} €</span>${showVk ? `<span>VK ${eur(st.rows.reduce((s, r) => s + (vk(r) || 0) * (Number(r.quantity) || 1), 0))} €</span>` : ''}</div>`;
  }
  updateButton();
}
$('rows').addEventListener('input', (e) => {
  const el = e.target; if (!el.dataset.k) return;
  const r = st.rows[+el.dataset.i]; if (!r) return;
  r[el.dataset.k] = el.value;
  if (el.dataset.k === 'unit_price' && st.target === 'auftrag') {
    const vkEl = document.querySelector(`input[data-i="${el.dataset.i}"][data-k="sale_price"]`);
    if (vkEl && !r._vkTouched) { r.sale_price = null; vkEl.value = eur(vk(r)); }
  }
  if (el.dataset.k === 'sale_price') r._vkTouched = true;
  updateButton();
});
$('rows').addEventListener('click', (e) => { const d = e.target.closest('[data-del]'); if (d) { st.rows.splice(+d.dataset.del, 1); renderRows(); } });

/* ---------- Seite lesen ---------- */
async function readPage() {
  $('srcTxt').textContent = 'Warenkorb wird gelesen …';
  try {
    // ?tabId= nur für automatische Tests (Popup als eigener Tab geöffnet)
    const forced = Number(new URLSearchParams(location.search).get('tabId')) || 0;
    const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
    st.tab = tab;
    if (!tab || !/^https?:/.test(tab.url || '')) throw new Error('nopage');
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: alReadPage });
    const out = res && res.result || { mode: 'nichts', lines: [] };
    // Warenkorb steckt manchmal in einem eingebetteten Rahmen (iframe) – dann dort suchen
    if ((!out.lines || !out.lines.length) && out.mode !== 'auswahl') {
      const all = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: alReadPage }).catch(() => []);
      const best = all.map(r => r.result).filter(r => r && r.lines && r.lines.length).sort((a, b) => b.lines.length - a.lines.length)[0];
      if (best) Object.assign(out, best);
    }
    st.source = out;
    st.rows = parseCart(out.lines || []);
    const sup = supplierFromHost(out.host);
    $('supplier').value = sup;
    if (sup === 'sonstige') $('supplier').dataset.host = out.host || '';
    // Beim Reifen-Großhändler gleich das Neureifen-Lager vorschlagen
    if (TIRE_SUPPLIERS.includes(sup)) setTarget('reifen');
    $('srcTxt').textContent = out.mode === 'auswahl' ? `Markierter Text · ${st.rows.length} Zeile${st.rows.length === 1 ? '' : 'n'}` : st.rows.length ? `Erkannt auf ${out.host}` : 'Kein Warenkorb erkannt';
  } catch (e) {
    st.source = { mode: 'nichts', lines: [] }; st.rows = [];
    $('srcTxt').textContent = e.message === 'nopage' ? 'Diese Seite kann nicht gelesen werden' : 'Seite konnte nicht gelesen werden';
  }
  renderRows();
}
$('btnReread').addEventListener('click', readPage);
$('btnPaste').addEventListener('click', () => {
  const rows = parseCart($('pasteTxt').value);
  if (!rows.length) { say('In dem Text wurden keine Positionen erkannt.', 'err'); return; }
  st.rows = rows; st.source = { mode: 'auswahl' }; say('');
  $('srcTxt').textContent = `Eingefügter Text · ${rows.length} Zeile${rows.length === 1 ? '' : 'n'}`;
  $('pasteBox').open = false; renderRows();
});

/* ---------- Ziel: Auftrag oder Lager ---------- */
function setTarget(t) {
  st.target = t;
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x.dataset.target === t));
  $('orderPick').hidden = t !== 'auftrag'; $('lagerInfo').hidden = t !== 'lager'; $('reifenInfo').hidden = t !== 'reifen';
  renderRows();
}
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setTarget(b.dataset.target)));
function renderOrders() {
  const q = $('orderSearch').value.trim().toLowerCase().replace(/[\s-]/g, '');
  let list = st.orders;
  if (q) list = list.filter(o => [o.plate, o.number, o.customer, o.vehicle].join(' ').toLowerCase().replace(/[\s-]/g, '').includes(q));
  // gewählter Auftrag immer oben
  const sel = st.orders.find(o => o.id === st.orderId);
  if (sel) list = [sel, ...list.filter(o => o.id !== sel.id)];
  $('orderList').innerHTML = list.slice(0, 30).map(o => `<button class="ord ${o.id === st.orderId ? 'on' : ''}" data-oid="${esc(o.id)}"><b>${esc(o.plate || '–')} · ${esc(o.vehicle || 'Fahrzeug')}</b><span>${o.number ? '#' + esc(o.number) + ' · ' : ''}${esc(o.customer || '')}${o.locked ? ' · Rechnung festgeschrieben' : ''}</span></button>`).join('')
    || `<div class="empty">${st.orders.length ? 'Kein Auftrag gefunden.' : 'Keine offenen Aufträge.'}</div>`;
  const o = st.orders.find(x => x.id === st.orderId);
  $('toInvoice').disabled = !!(o && o.locked);
  if (o && o.locked) $('toInvoice').checked = false;
  updateButton();
}
$('orderSearch').addEventListener('input', renderOrders);
$('orderList').addEventListener('click', (e) => { const b = e.target.closest('[data-oid]'); if (b) { st.orderId = b.dataset.oid; renderOrders(); } });

function updateButton() {
  const n = st.rows.filter(r => String(r.part_name || r.part_number || '').trim()).length;
  const ok = n > 0 && !st.busy && (st.target === 'lager' || st.target === 'reifen' || st.orderId);
  $('btnImport').disabled = !ok;
  const o = st.orders.find(x => x.id === st.orderId);
  $('btnImport').textContent = st.busy ? 'Wird übernommen …' : !n ? 'Keine Positionen' : st.target === 'lager' ? `${n} Position${n === 1 ? '' : 'en'} ins Lager buchen` : st.target === 'reifen' ? `${n} Position${n === 1 ? '' : 'en'} ins Neureifen-Lager buchen` : o ? `${n} Position${n === 1 ? '' : 'en'} in ${o.plate || 'Auftrag'} übernehmen` : 'Bitte Auftrag wählen';
}

$('btnImport').addEventListener('click', async () => {
  const items = st.rows.filter(r => String(r.part_name || r.part_number || '').trim()).map(r => ({
    part_name: String(r.part_name || '').trim(), part_number: String(r.part_number || '').trim(), quantity: Math.max(1, parseInt(r.quantity, 10) || 1),
    unit_price: parseMoney(r.unit_price), sale_price: st.target === 'auftrag' ? vk(r) : null,
  }));
  const sup = $('supplier').value;
  st.busy = true; updateButton(); say('');
  try {
    const d = await api('extImport', { target: st.target, order_id: st.orderId, items, supplier_key: sup, supplier_name: sup === 'sonstige' ? ($('supplier').dataset.host || '') : '', to_invoice: $('toInvoice').checked });
    if (d.target === 'lager') say(`Lager: ${d.updated} Artikel aufgestockt, ${d.created} neu angelegt.`);
    else if (d.target === 'reifen') say(`Neureifen: ${d.updated} Artikel aufgestockt, ${d.created} neu angelegt${d.skipped ? ` · ${d.skipped} Zeile${d.skipped === 1 ? '' : 'n'} ohne erkennbare Reifengröße übersprungen` : ''}.`);
    else say(`${d.parts} Teil${d.parts === 1 ? '' : 'e'} im Auftrag ${d.order_number ? '#' + d.order_number : ''}${d.invoiced ? `, ${d.invoiced} auf der Rechnung` : ''}${d.invoice_locked ? ' – Rechnung ist festgeschrieben, darum nicht auf die Rechnung' : ''}.`);
    st.rows = []; renderRows();
  } catch (e) { say(e.message, 'err'); if (e.auth) setTimeout(init, 1500); }
  finally { st.busy = false; updateButton(); }
});

/* ---------- Fahrzeug aus dem Dashboard ---------- */
function renderVehicle() {
  const c = st.ctx;
  const fresh = c && Date.now() - (c.at || 0) < 12 * 3600_000;
  $('vehicle').hidden = !fresh;
  if (!fresh) return;
  $('vehTxt').textContent = [c.vehicle, c.plate, c.number ? '#' + c.number : ''].filter(Boolean).join(' · ');
  const btns = [];
  if (c.vin) btns.push(`<button class="chip" data-fill="vin">FIN einsetzen<small>${esc(c.vin)}</small></button>`);
  if (c.hsn && c.tsn) btns.push(`<button class="chip" data-fill="kba">HSN/TSN einsetzen<small>${esc(c.hsn)} ${esc(c.tsn)}</small></button>`);
  if (!btns.length) btns.push('<span class="hint">Keine FIN oder HSN/TSN im Auftrag.</span>');
  $('vehBtns').innerHTML = btns.join('');
}
$('vehBtns').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fill]'); if (!b || !st.ctx) return;
  const c = st.ctx;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: st.tab.id }, func: alFillVehicle, args: [b.dataset.fill, c.vin, c.hsn, c.tsn] });
    if (r && r.result && r.result.ok) { b.classList.add('ok'); b.firstChild.textContent = 'Eingesetzt '; }
    else { await navigator.clipboard.writeText(b.dataset.fill === 'vin' ? c.vin : `${c.hsn} ${c.tsn}`); b.firstChild.textContent = 'Kopiert – im Suchfeld einfügen '; }
  } catch (_) {
    try { await navigator.clipboard.writeText(b.dataset.fill === 'vin' ? c.vin : `${c.hsn} ${c.tsn}`); b.firstChild.textContent = 'Kopiert '; } catch (__) {}
  }
});
$('ctxClear').addEventListener('click', async () => { await chrome.storage.local.remove('context'); st.ctx = null; renderVehicle(); });

/* ---------- Start ---------- */
const openDash = (connect) => chrome.tabs.create({ url: DASHBOARD + (connect ? '/settings?al_ext=connect' : '/') });
$('btnConnect').addEventListener('click', () => { openDash(true); window.close(); });
$('btnOpenDash').addEventListener('click', () => openDash(false));
$('supplier').innerHTML = Object.entries(SUPPLIER_NAMES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
$('ver').textContent = 'Version ' + chrome.runtime.getManifest().version;

async function init() {
  const s = await chrome.storage.local.get(['token', 'workshop_name', 'user_name', 'context']);
  st.token = s.token || null; st.ctx = s.context || null;
  $('connect').hidden = !!st.token; $('app').hidden = !st.token;
  if (!st.token) { $('who').textContent = 'Nicht verbunden'; return; }
  $('who').textContent = [s.workshop_name, s.user_name].filter(Boolean).join(' · ');
  renderVehicle();
  readPage();
  try {
    const [me, ol] = await Promise.all([api('extMe'), api('extOrders')]);
    st.me = me; st.markup = Number(me.markup_percent) || 0; st.orders = ol.orders || [];
    $('who').textContent = [me.workshop_name, me.user_name].filter(Boolean).join(' · ');
    if (st.ctx && st.orders.some(o => o.id === st.ctx.id)) st.orderId = st.ctx.id;
    renderOrders(); renderRows();
  } catch (e) {
    say(e.message, 'err');
    if (e.auth) { $('connect').hidden = false; $('app').hidden = true; }
  }
}
init();
