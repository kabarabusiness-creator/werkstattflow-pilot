// HTML der CEO-Konsole (eine Datei, kein Build). Alle Daten kommen über POST /ceo/api und werden escaped ausgegeben.
export function renderCeoPage() {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>AutoLeitwerk – CEO-Konsole</title>
<style>
:root{--bg:#0d0d17;--panel:#161625;--panel2:#1d1d30;--line:#2a2a44;--text:#ececf6;--muted:#9a9ab8;--faint:#6d6d8c;--accent:#8b5cf6;--accent2:#c4b5fd;--soft:rgba(139,92,246,.14);--ok:#22c55e;--warn:#f5a524;--bad:#f87171;--r:14px}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--accent2)}
.hidden{display:none!important}
/* Login */
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.login-card{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}.logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#8b5cf6,#6d28d9);display:flex;align-items:center;justify-content:center;font-weight:900}
.brand b{font-size:17px;letter-spacing:.02em}.brand span{display:block;font-size:12px;color:var(--muted)}
label{display:block;font-size:12.5px;color:var(--muted);margin:14px 0 6px;font-weight:600}
input[type=email],input[type=text],input[type=date],select,textarea{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px 12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
textarea{min-height:90px;resize:vertical}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--line);background:var(--panel2);border-radius:10px;padding:9px 14px;font-weight:600;cursor:pointer}
.btn:hover{border-color:#3d3d62}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.primary:hover{background:#7c4ef0}
.btn.danger{color:var(--bad)}.btn.block{width:100%;margin-top:16px;padding:12px}.btn:disabled{opacity:.5;cursor:default}
.msg{font-size:13.5px;margin-top:12px;color:var(--muted)}.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
/* App */
.top{position:sticky;top:0;z-index:5;background:rgba(13,13,23,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top-in{max-width:1240px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.tabs{display:flex;gap:4px;flex-wrap:wrap;flex:1}
.tab{border:0;background:transparent;color:var(--muted);padding:8px 12px;border-radius:9px;font-weight:600;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.tab.active{background:var(--soft);color:var(--accent2)}.tab .n{background:var(--bad);color:#fff;border-radius:99px;font-size:11px;padding:0 6px;min-width:18px;text-align:center}
main{max-width:1240px;margin:0 auto;padding:22px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}.sub{color:var(--muted);font-size:13.5px;margin-bottom:18px}
.grid{display:grid;gap:12px}.kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:18px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px}.kpi b{font-size:26px;display:block}.kpi span{font-size:12.5px;color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-bottom:14px;min-width:0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sp{flex:1}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;padding:3px 9px;border-radius:99px;background:var(--panel2);color:var(--muted)}
.pill.ok{background:rgba(34,197,94,.13);color:#4ade80}.pill.warn{background:rgba(245,165,36,.14);color:var(--warn)}.pill.bad{background:rgba(248,113,113,.14);color:var(--bad)}.pill.acc{background:var(--soft);color:var(--accent2)}
.tbl-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--faint);font-weight:600;font-size:12px}
.mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin-top:10px}
.mod{display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:13.5px}
.mod small{display:block;color:var(--faint);font-size:11px}
.sw{position:relative;width:40px;height:22px;flex-shrink:0}.sw input{opacity:0;width:0;height:0}.sw i{position:absolute;inset:0;background:#33334d;border-radius:99px;transition:.2s;cursor:pointer}
.sw i:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}.sw input:checked+i{background:var(--accent)}.sw input:checked+i:before{transform:translateX(18px)}
.sec-t{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);font-weight:700;margin:14px 0 2px}
.split{display:grid;grid-template-columns:minmax(0,380px) minmax(0,1fr);gap:14px}
@media(max-width:860px){.split{grid-template-columns:minmax(0,1fr)}}
.list-item{padding:11px 12px;border:1px solid var(--line);border-radius:11px;margin-bottom:8px;cursor:pointer;background:var(--panel2)}
.list-item.active{border-color:var(--accent)}.list-item b{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list-item p{margin:3px 0 0;color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:var(--bad);display:inline-block}
.msgs{max-height:52vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin:12px 0}
.bubble{max-width:85%;padding:9px 12px;border-radius:12px;background:var(--panel2);white-space:pre-wrap;word-wrap:break-word;font-size:14px}
.bubble.admin{align-self:flex-end;background:var(--soft)}.bubble small{display:block;color:var(--faint);font-size:11px;margin-top:4px}
.kv{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:6px 14px;font-size:13.5px}.kv span{color:var(--muted)}.kv b{font-weight:600;word-break:break-word}
pre{background:var(--panel2);border-radius:10px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin:6px 0 0}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#24243a;border:1px solid var(--line);padding:10px 16px;border-radius:12px;font-size:14px;z-index:20;max-width:calc(100% - 32px)}
.empty{color:var(--faint);font-size:13.5px;padding:10px 0}
</style></head>
<body>
<section class="login" id="login">
  <div class="login-card">
    <div class="brand"><div class="logo">L</div><div><b>AUTOLEITWERK</b><span>CEO-Konsole · nur für den Inhaber</span></div></div>
    <div id="stepMail">
      <label for="email">E-Mail-Adresse</label>
      <input type="email" id="email" autocomplete="email" placeholder="name@firma.de">
      <button class="btn primary block" id="sendCode">Anmeldecode senden</button>
    </div>
    <div id="stepCode" class="hidden">
      <label for="code">6-stelliger Code aus der E-Mail</label>
      <input type="text" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
      <button class="btn primary block" id="doLogin">Anmelden</button>
      <button class="btn block" id="back">Andere Adresse / neuen Code</button>
    </div>
    <div class="msg" id="loginMsg"></div>
  </div>
</section>

<section id="app" class="hidden">
  <div class="top"><div class="top-in">
    <div class="brand" style="margin:0"><div class="logo">L</div><div><b>CEO-Konsole</b><span>AutoLeitwerk</span></div></div>
    <nav class="tabs" id="tabs">
      <button class="tab active" data-tab="overview">Übersicht</button>
      <button class="tab" data-tab="workshops">Werkstätten &amp; Funktionen</button>
      <button class="tab" data-tab="support">Support <span class="n hidden" id="supN"></span></button>
      <button class="tab" data-tab="dev">Entwickler-Tools</button>
      <button class="tab" data-tab="settings">Einstellungen</button>
    </nav>
    <button class="btn" id="logout">Abmelden</button>
  </div></div>
  <main id="view"></main>
</section>
<div class="toast hidden" id="toast"></div>

<script>
(function(){
  var TK = 'al_ceo_token';
  var token = null; try { token = sessionStorage.getItem(TK); } catch(e) {}
  var state = { tab: 'overview', ov: null, sup: null, sel: null, dev: null };
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function toast(t){ var el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function(){ el.classList.add('hidden'); }, 3200); }
  function dt(s){ if(!s) return '–'; var v = String(s); var d = new Date(/Z|[+-]\\d\\d:?\\d\\d$/.test(v) ? v : v + 'Z'); if(isNaN(d)) return esc(v); return d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }); }
  function day(s){ if(!s) return '–'; var p = String(s).slice(0,10).split('-'); return p.length===3 ? p[2]+'.'+p[1]+'.'+p[0] : esc(s); }
  function eur(n){ return (Number(n)||0).toLocaleString('de-DE', { style:'currency', currency:'EUR', maximumFractionDigits:0 }); }

  async function api(action, data, raw){
    var res = await fetch('/ceo/api', { method:'POST', headers: Object.assign({ 'Content-Type':'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify(Object.assign({ action: action }, data || {})) });
    if(raw && res.ok) return res;
    var j = await res.json().catch(function(){ return {}; });
    if(res.status === 401 && action !== 'login'){ logoutLocal('Sitzung abgelaufen – bitte neu anmelden.'); throw new Error('unauthorized'); }
    if(!res.ok || j.ok === false){ var e = new Error(j.message || j.error || ('Fehler ' + res.status)); e.code = j.error; throw e; }
    return j;
  }
  function logoutLocal(msg){ token = null; try { sessionStorage.removeItem(TK); } catch(e) {} $('app').classList.add('hidden'); $('login').classList.remove('hidden'); $('stepMail').classList.remove('hidden'); $('stepCode').classList.add('hidden'); $('loginMsg').textContent = msg || ''; }

  /* ---------- Login ---------- */
  $('sendCode').onclick = async function(){
    var email = $('email').value.trim(); if(!email) return;
    this.disabled = true;
    try { await api('request_code', { email: email }); $('stepMail').classList.add('hidden'); $('stepCode').classList.remove('hidden'); $('loginMsg').className = 'msg'; $('loginMsg').textContent = 'Wenn die Adresse berechtigt ist, ist ein Code unterwegs (gültig 10 Minuten).'; $('code').focus(); }
    catch(e){ $('loginMsg').className = 'msg err'; $('loginMsg').textContent = e.code === 'too_many_requests' ? 'Zu viele Versuche – bitte später erneut.' : e.message; }
    this.disabled = false;
  };
  $('doLogin').onclick = async function(){
    this.disabled = true;
    try { var r = await api('login', { email: $('email').value.trim(), code: $('code').value.trim() }); token = r.token; try { sessionStorage.setItem(TK, token); } catch(e) {} start(); }
    catch(e){ $('loginMsg').className = 'msg err'; $('loginMsg').textContent = e.code === 'too_many_requests' ? 'Zu viele Versuche – bitte später erneut.' : (e.message || 'Anmeldung fehlgeschlagen.'); }
    this.disabled = false;
  };
  $('code').addEventListener('keydown', function(e){ if(e.key === 'Enter') $('doLogin').click(); });
  $('email').addEventListener('keydown', function(e){ if(e.key === 'Enter') $('sendCode').click(); });
  $('back').onclick = function(){ $('stepCode').classList.add('hidden'); $('stepMail').classList.remove('hidden'); $('loginMsg').textContent = ''; };
  $('logout').onclick = async function(){ try { await api('logout'); } catch(e) {} logoutLocal('Abgemeldet.'); };
  $('tabs').onclick = function(e){ var b = e.target.closest('[data-tab]'); if(!b) return; state.tab = b.dataset.tab; document.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t === b); }); load(); };

  function start(){ $('login').classList.add('hidden'); $('app').classList.remove('hidden'); load(); }
  async function load(){
    var v = $('view');
    v.innerHTML = '<div class="empty">Lädt…</div>';
    try {
      if(state.tab === 'overview' || state.tab === 'workshops' || state.tab === 'settings'){ state.ov = await api('overview'); badge(state.ov.totals.support_open); }
      if(state.tab === 'overview') renderOverview();
      if(state.tab === 'workshops') renderWorkshops();
      if(state.tab === 'settings') renderSettings();
      if(state.tab === 'support'){ state.sup = await api('support_list'); renderSupport(); }
      if(state.tab === 'dev'){ state.dev = await api('dev'); renderDev(); }
    } catch(e){ if(e.message !== 'unauthorized') v.innerHTML = '<div class="card msg err">' + esc(e.message) + '</div>'; }
  }
  function badge(n){ var el = $('supN'); el.textContent = n; el.classList.toggle('hidden', !n); }
  function statusPill(st){ return st.ok ? '<span class="pill ok">● Alles in Ordnung</span>' : '<span class="pill bad">● ' + esc(st.problems.join(' · ')) + '</span>'; }
  function aboPill(w){ var m = { active:['ok','Zahlend'], trial:['acc','Testphase'], expired:['bad','Abgelaufen'] }[w.subscription_status] || ['', w.subscription_status]; return '<span class="pill ' + m[0] + '">' + esc(m[1]) + '</span>'; }

  /* ---------- Übersicht ---------- */
  function renderOverview(){
    var o = state.ov, t = o.totals;
    var k = [['Werkstätten', t.workshops], ['Aktiv', t.active], ['Zahlend', t.paying], ['Testphase', t.trial], ['Aktive Aufträge', t.orders_active], ['Mitarbeiter', t.employees], ['Offene Support-Fälle', t.support_open]];
    $('view').innerHTML = '<h1>Übersicht</h1><div class="sub">Alle Werkstätten auf einen Blick · ' + dt(new Date().toISOString()) + '</div>'
      + (o.settings.maintenance ? '<div class="card" style="border-color:var(--warn)"><b style="color:var(--warn)">Wartungsmodus ist AN</b> – Tablet und Kundenportal sind für alle Werkstätten gesperrt. <a href="#" data-go="settings">Ändern</a></div>' : '')
      + '<div class="grid kpis">' + k.map(function(x){ return '<div class="kpi"><b>' + esc(x[1]) + '</b><span>' + esc(x[0]) + '</span></div>'; }).join('') + '</div>'
      + '<div class="card"><div class="row"><h2 style="margin:0">Systemstatus</h2><span class="sp"></span>' + statusPill(o.status) + '</div><div class="msg">Letzte Prüfung: ' + dt(o.status.checked_at) + ' · Letztes Backup: ' + day(o.status.last_backup) + '</div></div>'
      + '<div class="card"><h2>Werkstätten</h2><div class="tbl-wrap"><table><thead><tr><th>Werkstatt</th><th>Code</th><th>Status</th><th>Abo</th><th>Aktive Aufträge</th><th>Aufträge Monat</th><th>Umsatz Monat</th><th>Mitarbeiter</th><th>Termine 7 Tage</th><th>Tablet-Logins 7 Tage</th><th>Letzte Aktivität</th></tr></thead><tbody>'
      + (o.workshops.length ? o.workshops.map(function(w){ return '<tr><td><b>' + esc(w.name) + '</b></td><td>' + esc(w.code) + '</td><td>' + (w.is_active ? '<span class="pill ok">Aktiv</span>' : '<span class="pill bad">Gesperrt</span>') + '</td><td>' + aboPill(w) + (w.trial_ends_at && w.subscription_status === 'trial' ? ' <small style="color:var(--faint)">bis ' + day(w.trial_ends_at) + '</small>' : '') + '</td><td>' + w.orders_active + '</td><td>' + w.orders_month + '</td><td>' + eur(w.revenue_month) + '</td><td>' + w.employees + '</td><td>' + w.appts_week + '</td><td>' + w.tablet_logins_7d + '</td><td>' + dt(w.last_activity) + '</td></tr>'; }).join('') : '<tr><td colspan="11" class="empty">Noch keine Werkstätten.</td></tr>')
      + '</tbody></table></div></div>';
  }

  /* ---------- Werkstätten & Funktionen ---------- */
  function sw(attrs, on){ return '<label class="sw"><input type="checkbox" ' + attrs + (on ? ' checked' : '') + '><i></i></label>'; }
  function renderWorkshops(){
    var o = state.ov;
    var modRow = function(w, m){ var on = w.modules[m.key] !== false; return '<div class="mod"><div>' + esc(m.label) + (m.server ? '<small>wird vom Server durchgesetzt</small>' : '') + '</div>' + sw('data-mod="' + esc(m.key) + '" data-id="' + esc(w.id) + '"', on) + '</div>'; };
    $('view').innerHTML = '<h1>Werkstätten &amp; Funktionen</h1><div class="sub">Werkstatt sperren, Abo und Testphase pflegen, einzelne Funktionen ein- und ausschalten. Änderungen gelten sofort (Tablet spätestens nach 30 Sekunden).</div>'
      + (o.workshops.length ? o.workshops.map(function(w){
        return '<div class="card"><div class="row"><div><h2 style="margin:0">' + esc(w.name) + '</h2><div class="msg" style="margin:2px 0 0">Code ' + esc(w.code) + ' · ' + w.employees + ' Mitarbeiter · letzte Aktivität ' + dt(w.last_activity) + '</div></div><span class="sp"></span>'
          + '<span class="pill ' + (w.is_active ? 'ok' : 'bad') + '">' + (w.is_active ? 'Aktiv' : 'Gesperrt') + '</span>' + sw('data-active="' + esc(w.id) + '"', w.is_active) + '</div>'
          + '<div class="row" style="margin-top:12px"><div style="min-width:160px"><label>Abo-Status</label><select data-abo="' + esc(w.id) + '">' + [['trial','Testphase'],['active','Zahlend'],['expired','Abgelaufen']].map(function(x){ return '<option value="' + x[0] + '"' + (w.subscription_status === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>'
          + '<div style="min-width:160px"><label>Testphase endet am</label><input type="date" data-trial="' + esc(w.id) + '" value="' + esc(w.trial_ends_at ? String(w.trial_ends_at).slice(0,10) : '') + '"></div></div>'
          + '<div class="sec-t">Server-Funktionen</div><div class="mods">' + o.modules.server.map(function(m){ return modRow(w, m); }).join('') + '</div>'
          + '<div class="sec-t">Dashboard-Module</div><div class="mods">' + o.modules.dashboard.map(function(m){ return modRow(w, m); }).join('') + '</div></div>';
      }).join('') : '<div class="card empty">Noch keine Werkstätten.</div>');
  }
  async function updWs(id, data, label){ try { await api('workshop_update', Object.assign({ id: id }, data)); toast(label + ' gespeichert'); state.ov = await api('overview'); if(state.tab === 'workshops') renderWorkshops(); } catch(e){ toast('Fehler: ' + e.message); load(); } }
  document.addEventListener('change', function(e){
    var t = e.target;
    if(t.dataset.mod){ var m = {}; m[t.dataset.mod] = t.checked; updWs(t.dataset.id, { modules: m }, 'Funktion'); }
    else if(t.dataset.active){ if(!t.checked && !confirmText('Werkstatt wirklich sperren? Tablet und Kundenportal funktionieren dann nicht mehr.')){ t.checked = true; return; } updWs(t.dataset.active, { is_active: t.checked }, 'Status'); }
    else if(t.dataset.abo){ updWs(t.dataset.abo, { subscription_status: t.value }, 'Abo-Status'); }
    else if(t.dataset.trial !== undefined && t.hasAttribute('data-trial')){ updWs(t.dataset.trial, { trial_ends_at: t.value || null }, 'Testphase'); }
  });
  function confirmText(q){ return window.confirm(q); }

  /* ---------- Support ---------- */
  function renderSupport(){
    var s = state.sup;
    var openChats = s.chats.filter(function(c){ return c.status !== 'abgeschlossen'; }).length, openT = s.tickets.filter(function(t){ return t.status !== 'erledigt'; }).length;
    badge(s.chats.filter(function(c){ return c.unread && c.status !== 'abgeschlossen'; }).length + openT);
    var stP = function(st){ var m = { offen:'bad', in_bearbeitung:'warn', abgeschlossen:'ok', erledigt:'ok' }; var l = { offen:'Offen', in_bearbeitung:'In Bearbeitung', abgeschlossen:'Abgeschlossen', erledigt:'Erledigt' }; return '<span class="pill ' + (m[st]||'') + '">' + esc(l[st] || st) + '</span>'; };
    var items = '<div class="sec-t" style="margin-top:0">Live-Chat (' + openChats + ' offen)</div>'
      + (s.chats.length ? s.chats.map(function(c){ return '<div class="list-item' + (state.sel && state.sel.type==='chat' && state.sel.id===c.id ? ' active' : '') + '" data-chat="' + esc(c.id) + '"><div class="row">' + (c.unread ? '<span class="dot"></span>' : '') + '<b style="flex:1">' + esc(c.subject || 'Ohne Betreff') + '</b>' + stP(c.status) + '</div><p>' + esc(c.user_name || c.user_email || '–') + ' · ' + dt(c.last_message_at) + '</p><p>' + (c.last_sender === 'admin' ? 'Du: ' : '') + esc(c.last_message) + '</p></div>'; }).join('') : '<div class="empty">Keine Chats.</div>')
      + '<div class="sec-t">Weitere Anfragen (' + openT + ' offen)</div>'
      + (s.tickets.length ? s.tickets.map(function(t){ return '<div class="list-item' + (state.sel && state.sel.type==='ticket' && state.sel.id===t.id ? ' active' : '') + '" data-ticket="' + esc(t.id) + '"><div class="row"><b style="flex:1">' + esc(t.subject) + '</b>' + stP(t.status) + '</div><p>' + esc(t.name || t.email || '–') + (t.workshop_code ? ' · ' + esc(t.workshop_code) : '') + ' · ' + dt(t.created_at) + '</p><p>' + esc(t.source) + ': ' + esc(t.message) + '</p></div>'; }).join('') : '<div class="empty">Keine weiteren Anfragen. Neue Anfragen über das Support-Formular im Dashboard landen hier.</div>');
    $('view').innerHTML = '<h1>Support</h1><div class="sub">Live-Chat-Anfragen und alle Anfragen aus dem Support-Formular. Antworten gehen sofort an den Nutzer (im Chat und per E-Mail).</div><div class="split"><div>' + items + '</div><div id="detail"><div class="card empty">Links eine Anfrage auswählen.</div></div></div>';
    if(state.sel) openSel();
  }
  async function openSel(){
    var d = $('detail'); if(!d) return;
    d.innerHTML = '<div class="card empty">Lädt…</div>';
    try {
      if(state.sel.type === 'chat'){
        var r = await api('chat_get', { id: state.sel.id }), s = r.session;
        d.innerHTML = '<div class="card"><div class="row"><div><h2 style="margin:0">' + esc(s.subject || 'Ohne Betreff') + '</h2><div class="msg" style="margin:2px 0 0">' + esc(s.user_name || '') + ' &lt;' + esc(s.user_email || '–') + '&gt;</div></div><span class="sp"></span><select id="chatSt" style="width:auto">' + [['offen','Offen'],['in_bearbeitung','In Bearbeitung'],['abgeschlossen','Abgeschlossen']].map(function(x){ return '<option value="' + x[0] + '"' + (s.status===x[0]?' selected':'') + '>' + x[1] + '</option>'; }).join('') + '</select></div>'
          + '<div class="msgs" id="msgs">' + r.messages.map(function(m){ return '<div class="bubble ' + (m.sender === 'admin' ? 'admin' : '') + '">' + esc(m.content) + (m.attachments || []).map(function(a){ return '<br><a href="' + esc(a.url) + '" target="_blank" rel="noopener">📎 ' + esc(a.name || 'Anhang') + '</a>'; }).join('') + '<small>' + esc(m.sender === 'admin' ? (m.author_name || 'Support') : (m.author_name || s.user_name || 'Nutzer')) + ' · ' + dt(m.created_date) + '</small></div>'; }).join('') + '</div>'
          + '<textarea id="reply" placeholder="Antwort schreiben…"></textarea><div class="row" style="margin-top:8px"><span class="sp"></span><button class="btn primary" id="sendReply">Antwort senden</button></div></div>';
        var ms = $('msgs'); ms.scrollTop = ms.scrollHeight;
        $('chatSt').onchange = async function(){ try { await api('chat_status', { id: s.id, status: this.value }); toast('Status gespeichert'); refreshSupport(); } catch(e){ toast('Fehler: ' + e.message); } };
        $('sendReply').onclick = async function(){ var c = $('reply').value.trim(); if(!c) return; this.disabled = true; try { await api('chat_reply', { id: s.id, content: c }); toast('Antwort gesendet'); refreshSupport(); } catch(e){ toast('Fehler: ' + e.message); this.disabled = false; } };
      } else {
        var t = (await api('ticket_get', { id: state.sel.id })).ticket;
        d.innerHTML = '<div class="card"><div class="row"><div><h2 style="margin:0">' + esc(t.subject) + '</h2><div class="msg" style="margin:2px 0 0">' + esc(t.name || '') + ' &lt;' + esc(t.email || '–') + '&gt;' + (t.workshop_code ? ' · Werkstatt ' + esc(t.workshop_code) : '') + ' · ' + dt(t.created_at) + '</div></div><span class="sp"></span><select id="tSt" style="width:auto">' + [['offen','Offen'],['in_bearbeitung','In Bearbeitung'],['erledigt','Erledigt']].map(function(x){ return '<option value="' + x[0] + '"' + (t.status===x[0]?' selected':'') + '>' + x[1] + '</option>'; }).join('') + '</select></div>'
          + '<div class="msgs"><div class="bubble">' + esc(t.message) + '<small>' + esc(t.source) + '</small></div>' + (t.replies || []).map(function(x){ return '<div class="bubble admin">' + esc(x.message) + '<small>Antwort per E-Mail · ' + dt(x.at) + '</small></div>'; }).join('') + '</div>'
          + (t.email ? '<textarea id="reply" placeholder="Antwort per E-Mail an ' + esc(t.email) + '…"></textarea><div class="row" style="margin-top:8px"><span class="sp"></span><button class="btn primary" id="sendReply">Antwort senden</button></div>' : '<div class="empty">Keine E-Mail-Adresse hinterlegt.</div>') + '</div>';
        $('tSt').onchange = async function(){ try { await api('ticket_status', { id: t.id, status: this.value }); toast('Status gespeichert'); refreshSupport(); } catch(e){ toast('Fehler: ' + e.message); } };
        var b = $('sendReply'); if(b) b.onclick = async function(){ var c = $('reply').value.trim(); if(!c) return; this.disabled = true; try { await api('ticket_reply', { id: t.id, message: c }); toast('Antwort gesendet'); refreshSupport(); } catch(e){ toast('Fehler: ' + e.message); this.disabled = false; } };
      }
    } catch(e){ d.innerHTML = '<div class="card msg err">' + esc(e.message) + '</div>'; }
  }
  async function refreshSupport(){ state.sup = await api('support_list'); renderSupport(); }
  document.addEventListener('click', function(e){
    var c = e.target.closest('[data-chat]'), t = e.target.closest('[data-ticket]'), go = e.target.closest('[data-go]');
    if(c){ state.sel = { type:'chat', id: c.dataset.chat }; renderSupport(); }
    else if(t){ state.sel = { type:'ticket', id: t.dataset.ticket }; renderSupport(); }
    else if(go){ e.preventDefault(); var b = document.querySelector('[data-tab="' + go.dataset.go + '"]'); if(b) b.click(); }
  });

  /* ---------- Entwickler-Tools ---------- */
  function renderDev(){
    var d = state.dev, c = d.config, m = d.monitor || {};
    var yes = function(v){ return v ? '<span class="pill ok">ja</span>' : '<span class="pill bad">nein</span>'; };
    $('view').innerHTML = '<h1>Entwickler-Tools</h1><div class="sub">Server-Zustand, Prüfungen, Backups und Konfiguration. Stand ' + dt(d.time) + '</div>'
      + '<div class="card"><div class="row"><h2 style="margin:0">Status</h2><span class="sp"></span>' + statusPill(d.status) + '</div><div class="kv" style="margin-top:12px"><span>Letzte Prüfung</span><b>' + dt(d.status.checked_at) + '</b><span>Fehlprüfungen in Folge</span><b>' + esc(m.fail_count || 0) + '</b><span>Störung seit</span><b>' + (m.since ? dt(m.since) : '–') + '</b><span>Letztes Backup</span><b>' + (m.last_backup ? day(m.last_backup.day) + ' · ' + Math.round((m.last_backup.bytes||0)/1024) + ' KB' : '–') + '</b><span>Externe Prüfung</span><b><a href="/health" target="_blank">/health</a> · <a href="/status" target="_blank">/status</a></b></div>'
      + '<div class="row" style="margin-top:14px"><button class="btn" data-dev="dev_run_checks">Prüfung jetzt ausführen</button><button class="btn" data-dev="dev_backup_now">Backup jetzt erstellen</button><button class="btn" data-dev="dev_test_mail">Test-Mail an mich</button><button class="btn" data-dev="dev_clear_cache">Server-Cache leeren</button><button class="btn" id="exportAll">Komplett-Export laden</button></div></div>'
      + '<div class="card"><h2>Konfiguration</h2><div class="kv"><span>Datenbank (Base44)</span><b>' + yes(c.base44) + ' ' + esc(c.app_id || '') + '</b><span>KI (Workers AI)</span><b>' + yes(c.ki) + '</b><span>Speicher (KV)</span><b>' + yes(c.speicher) + '</b><span>E-Mail-Versand</span><b>' + yes(c.email) + ' ' + esc(c.mail_from) + '</b><span>Admin-Schlüssel</span><b>' + yes(c.admin_key) + '</b><span>Support-Adresse</span><b>' + esc(c.support_email) + '</b><span>CEO-Adresse</span><b>' + esc(c.ceo_email) + '</b><span>Erlaubte Seiten</span><b>' + esc(c.allowed_origins || 'alle') + '</b><span>CEO-Sitzungen</span><b>' + esc(c.ceo_sessions) + ' <button class="btn danger" data-dev="dev_logout_all" style="padding:4px 10px;margin-left:8px">Alle anderen abmelden</button></b></div></div>'
      + '<div class="card"><h2>Backups (letzte 14 Tage)</h2>' + (d.backups.length ? '<div class="tbl-wrap"><table><thead><tr><th>Tag</th><th>Größe</th><th>Datensätze</th><th>Zustand</th><th></th></tr></thead><tbody>' + d.backups.map(function(b){ return '<tr><td>' + day(b.name.slice(0,10)) + '</td><td>' + Math.round((b.bytes||0)/1024) + ' KB</td><td>' + esc(b.records == null ? '–' : b.records) + '</td><td>' + (b.failed && b.failed.length ? '<span class="pill warn">unvollständig</span>' : '<span class="pill ok">ok</span>') + '</td><td><button class="btn" data-bk="' + esc(b.name) + '" style="padding:5px 10px">Laden</button></td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">Noch keine Backups.</div>') + '</div>'
      + '<div class="card"><h2>Letzte Server-Fehler</h2><div class="msg" style="margin-top:0">Nur seit dem letzten Neustart dieser Server-Instanz.</div>' + (d.errors.length ? d.errors.map(function(x){ return '<div style="margin-top:10px"><b style="font-size:13px">' + dt(x.at) + ' · ' + esc(x.where) + '</b><pre>' + esc(x.error) + '</pre></div>'; }).join('') : '<div class="empty">Keine Fehler.</div>') + '</div>';
    $('exportAll').onclick = function(){ download('dev_export', {}, this); };
  }
  async function download(action, data, btn){
    if(btn) btn.disabled = true;
    try {
      var res = await api(action, data, true);
      var cd = res.headers.get('Content-Disposition') || ''; var m = /filename="([^"]+)"/.exec(cd);
      var blob = await res.blob(); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : 'autoleitwerk.json'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 5000);
    } catch(e){ toast('Fehler: ' + e.message); }
    if(btn) btn.disabled = false;
  }
  document.addEventListener('click', async function(e){
    var b = e.target.closest('[data-dev]'), bk = e.target.closest('[data-bk]');
    if(bk){ download('dev_backup_file', { name: bk.dataset.bk }, bk); return; }
    if(!b) return;
    var a = b.dataset.dev;
    if(a === 'dev_logout_all' && !window.confirm('Alle anderen CEO-Sitzungen beenden?')) return;
    b.disabled = true;
    try {
      var r = await api(a);
      if(a === 'dev_run_checks') toast(r.result.ok ? 'Prüfung: alles in Ordnung' : 'Prüfung: ' + r.result.problems.join(' · '));
      else if(a === 'dev_backup_now') toast('Backup erstellt (' + Math.round((r.result.bytes||0)/1024) + ' KB)');
      else if(a === 'dev_test_mail') toast(r.ok ? 'Test-Mail gesendet' : 'Test-Mail fehlgeschlagen: ' + (r.reason || ''));
      else if(a === 'dev_logout_all') toast(r.removed + ' Sitzung(en) beendet');
      else toast('Erledigt');
      state.dev = await api('dev'); renderDev();
    } catch(err){ toast('Fehler: ' + err.message); b.disabled = false; }
  });

  /* ---------- Einstellungen ---------- */
  function renderSettings(){
    var s = state.ov.settings;
    $('view').innerHTML = '<h1>Einstellungen</h1><div class="sub">Gilt für alle Werkstätten.</div>'
      + '<div class="card"><div class="row"><div><h2 style="margin:0">Wartungsmodus</h2><div class="msg" style="margin:2px 0 0">Sperrt Tablet-App und Kundenportal für alle Werkstätten und zeigt den Hinweis unten. Die CEO-Konsole bleibt erreichbar.</div></div><span class="sp"></span>' + sw('id="setMaint"', s.maintenance) + '</div>'
      + '<label for="setMaintMsg">Hinweis im Wartungsmodus</label><input type="text" id="setMaintMsg" maxlength="300" value="' + esc(s.maintenance_message) + '"></div>'
      + '<div class="card"><h2>Ankündigung im Tablet</h2><div class="msg" style="margin-top:0">Erscheint als Hinweis oben im Tablet aller Werkstätten (z. B. „Neu: Reifenscan …“). Leer lassen = keine Ankündigung.</div><label for="setAnn">Text</label><input type="text" id="setAnn" maxlength="300" value="' + esc(s.announcement) + '" placeholder="z. B. Am Montag 7–8 Uhr kurze Wartung"></div>'
      + '<div class="row"><span class="sp"></span>' + (s.updated_at ? '<span class="msg" style="margin:0">Zuletzt geändert ' + dt(s.updated_at) + '</span>' : '') + '<button class="btn primary" id="saveSet">Speichern</button></div>'
      + '<div class="card" style="margin-top:14px"><h2>Zugang</h2><div class="kv"><span>CEO-Anmeldung</span><b>nur per Einmal-Code an die CEO-Adresse</b><span>Sitzungsdauer</span><b>12 Stunden, danach neu anmelden</b><span>Werkstatt-Admins</span><b>haben keinen Zugriff auf diese Konsole</b></div></div>';
    $('saveSet').onclick = async function(){
      var maint = $('setMaint').checked;
      if(maint && !s.maintenance && !window.confirm('Wartungsmodus einschalten? Alle Werkstätten werden aus Tablet und Kundenportal ausgesperrt.')) return;
      this.disabled = true;
      try { var r = await api('settings_save', { maintenance: maint, maintenance_message: $('setMaintMsg').value, announcement: $('setAnn').value }); state.ov.settings = r.settings; toast('Einstellungen gespeichert'); renderSettings(); }
      catch(e){ toast('Fehler: ' + e.message); this.disabled = false; }
    };
  }

  if(token) start();
})();
</script>
</body></html>`;
}
