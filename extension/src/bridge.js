// Verbindung zwischen dem AutoLeitwerk-Dashboard und der Erweiterung (läuft nur auf login.autoleitwerk.de).
// - Zeigt dem Dashboard, dass die Erweiterung installiert ist (data-al-ext am <html>).
// - Nimmt den Erweiterungs-Schlüssel entgegen, wenn der Nutzer im Dashboard auf „Erweiterung verbinden“ tippt.
// - Merkt sich den Auftrag, aus dem zuletzt ein Teilekatalog geöffnet wurde (FIN, HSN/TSN für die Katalogsuche).
// Der Schlüssel des Dashboard-Logins wird nie gelesen.
(function () {
  const VERSION = chrome.runtime.getManifest().version;
  const mark = () => { try { document.documentElement.dataset.alExt = VERSION; } catch (_) {} };
  mark();
  document.addEventListener('DOMContentLoaded', mark);

  const reply = (msg) => window.postMessage({ source: 'al-ext', ...msg }, location.origin);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data || {};
    if (d.source !== 'al-dashboard') return;
    if (d.type === 'AL_EXT_PING') {
      chrome.storage.local.get(['token', 'workshop_name']).then((s) => reply({ type: 'AL_EXT_PONG', version: VERSION, connected: !!s.token, workshop_name: s.workshop_name || '' }));
    }
    if (d.type === 'AL_EXT_TOKEN' && typeof d.token === 'string' && /^alx_[a-f0-9]{48}$/.test(d.token)) {
      chrome.storage.local.set({ token: d.token, workshop_name: d.workshop_name || '', user_name: d.user_name || '', connected_at: new Date().toISOString() })
        .then(() => reply({ type: 'AL_EXT_CONNECTED', version: VERSION }));
    }
    if (d.type === 'AL_EXT_DISCONNECT') {
      chrome.storage.local.remove(['token', 'workshop_name', 'user_name', 'connected_at', 'context']).then(() => reply({ type: 'AL_EXT_PONG', version: VERSION, connected: false }));
    }
    if (d.type === 'AL_EXT_CONTEXT' && d.order && typeof d.order.id === 'string') {
      const o = d.order;
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      chrome.storage.local.set({ context: {
        id: clip(o.id, 40), number: clip(o.number, 20), plate: clip(o.plate, 20), vehicle: clip(o.vehicle, 80), customer: clip(o.customer, 80),
        vin: clip(o.vin, 20), hsn: clip(o.hsn, 8), tsn: clip(o.tsn, 12), at: Date.now(),
      } });
    }
  });
})();
