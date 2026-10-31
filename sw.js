/* AutoLeitwerk Tablet – Offline-Speicher (Service Worker)
   Hält Seite, Design, Programmcode und Bilder der Tablet-App auf dem Gerät, damit sie auch ohne WLAN startet.
   Betrifft nur die Tablet-App (index.html + ihre Dateien). Kundenportal, Datenschutz usw. und alle Anfragen an den
   Server (Aufträge, Speichern, ALEX) laufen unverändert direkt ins Netz.

   Seite: erst Netz (max. 4 s), sonst gespeicherte Fassung. tablet.css/js: haben eine Versionsnummer (?v=…) und
   werden einmal geladen und dann vom Gerät genommen. Bilder/Symbole: vom Gerät, im Hintergrund aktualisiert.

   Notbremse: Sollte hier je etwas klemmen, den Inhalt dieser Datei durch
     self.addEventListener('install',()=>self.skipWaiting());
     self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>self.registration.unregister())));
   ersetzen – beim nächsten Öffnen räumt sich alles selbst weg. */
const CACHE = 'al-tablet-v1';
const SCOPE = new URL(self.registration.scope).pathname; // z. B. /werkstattflow-pilot/
const VERSIONED = /^tablet\.(css|js)$/;
const STATIC = /^(assets\/img\/[^/]+|assets\/vendor\/[^/]+|icons\/[^/]+|manifest\.webmanifest)$/;

self.addEventListener('install', e => { e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('al-tablet-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function precache() {
  const c = await caches.open(CACHE);
  const res = await fetch('index.html', { cache: 'no-cache' });
  if (!res.ok) return;
  await c.put('index.html', res.clone());
  await cacheRefs(c, await res.text());
}
// Alles, was die aktuelle index.html braucht, ablegen; alte tablet.css/js-Versionen wegräumen
async function cacheRefs(c, html) {
  const refs = new Set(['assets/img/logo-wortmarke.png', 'assets/vendor/jsQR.js?v=1.4.0', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png']);
  for (const m of html.matchAll(/(?:href|src)="((?:tablet\.(?:css|js)|assets\/img\/|icons\/)[^"]*)"/g)) refs.add(m[1]);
  await Promise.all([...refs].map(async r => {
    try { if (await c.match(r)) return; const x = await fetch(r); if (x.ok) await c.put(r, x); } catch (_) {}
  }));
  const keep = new Set([...refs].map(r => new URL(r, self.registration.scope).href));
  for (const req of await c.keys()) if (/\/tablet\.(css|js)\?/.test(req.url) && !keep.has(req.url)) await c.delete(req);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  const rel = url.pathname.slice(SCOPE.length);
  if (req.mode === 'navigate') { if (rel === '' || rel === 'index.html') e.respondWith(page(req)); return; }
  if (VERSIONED.test(rel) && url.search) { e.respondWith(cacheFirst(req)); return; }
  if (STATIC.test(rel)) e.respondWith(staleWhileRevalidate(req, e));
});

async function page(req) {
  const c = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    if (res.ok) {
      await c.put('index.html', res.clone());
      res.clone().text().then(h => cacheRefs(c, h)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await c.match('index.html');
    return hit || Response.error();
  }
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await c.put(req, res.clone());
  return res;
}
async function staleWhileRevalidate(req, e) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}
