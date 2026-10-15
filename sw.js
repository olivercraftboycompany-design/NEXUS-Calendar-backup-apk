/* NEXUS Calendar service worker. Bump VERSION whenever a file changes so phones get the update. */
const VERSION = 'nexcal-v2';
importScripts('push-box.js');
const SHELL = [
  './', './index.html', './app.js', './reminders.js', './push-box.js', './style.css', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png',
  './icons/favicon-32.png', './icons/badge-96.png', './icons/shortcut-add.png', './icons/shortcut-today.png'
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'nexcal-fonts' && k !== 'nexcal-config') await caches.delete(k);
    await self.clients.claim();
  })());
});

// Network first (so updates show up), but never wait more than 3 s on a bad connection: fall back to the saved copy.
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; });
  const timeout = new Promise(r => setTimeout(r, 3000, null));
  try {
    const res = await Promise.race([net, timeout]);
    if (res) return res;
  } catch {}
  const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
  if (hit) return hit;
  try { return await net; } catch { return req.mode === 'navigate' ? new Response('<h1 style="font-family:sans-serif;color:#fafafa;background:#09090b">Offline</h1>', { headers: { 'Content-Type': 'text/html' } }) : Response.error(); }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('nexcal-fonts').then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }
      catch { return url.hostname === 'fonts.googleapis.com' ? new Response('/* offline */', { headers: { 'Content-Type': 'text/css' } }) : Response.error(); }
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  e.respondWith(networkFirst(req));
});

/* ---------- reminder notifications ---------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'NEXUS Calendar';
  const opts = {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    tag: d.tag || 'nxcal', renotify: true, vibrate: [120, 60, 120], timestamp: d.ts || Date.now(),
    data: { url: d.url || './' }
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'nxcal-push', title, body: opts.body, tag: opts.tag });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if (w.url !== target && 'navigate' in w) { try { await w.navigate(target); } catch {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// If Chrome rotates the push subscription, re-subscribe and tell the sender to move the reminders over.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const res = await (await caches.open('nexcal-config')).match('./nexcal-config.json');
    if (!res) return;
    const cfg = await res.json(); if (!cfg.on) return;
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: self.NXCalPush.b64u.dec(self.NXCalPush.VAPID_PUBLIC) });
    await self.NXCalPush.post({ type: 'resub', v: Date.now(), old: (e.oldSubscription && e.oldSubscription.endpoint) || cfg.endpoint, sub: sub.toJSON(), tz: cfg.tz });
    await (await caches.open('nexcal-config')).put('./nexcal-config.json', new Response(JSON.stringify({ ...cfg, endpoint: sub.endpoint })));
  })());
});
