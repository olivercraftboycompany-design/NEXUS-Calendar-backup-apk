/* NEXUS Calendar reminders: Web Push. Your phone subscribes, then sends a locked copy of the events that have
   reminders to a private inbox; a GitHub Action checks every minute and pushes the reminder at the right time. */
(() => {
'use strict';
const P = self.NXCalPush; const LSK = 'nxcal_push';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const st = () => { try { return JSON.parse(localStorage.getItem(LSK) || '{}'); } catch { return {}; } };
const setSt = v => { try { localStorage.setItem(LSK, JSON.stringify(v)); } catch {} };
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!(window.crypto && crypto.subtle) && window.isSecureContext;
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } };
const sameKey = sub => { try { const k = sub.options && sub.options.applicationServerKey; if (!k) return true; const a = new Uint8Array(k), b = P.b64u.dec(P.VAPID_PUBLIC); return a.length === b.length && a.every((x, i) => x === b[i]); } catch { return true; } };
async function reg() { return navigator.serviceWorker.ready; }
async function saveCfg(sub, on) { try { const c = await caches.open('nexcal-config'); await c.put('./nexcal-config.json', new Response(JSON.stringify({ on, endpoint: sub ? sub.endpoint : null, tz: tz() }), { headers: { 'Content-Type': 'application/json' } })); } catch {} }

function compact() {
  const C = window.NXCal, DB = C.DB, today = C.todayKey(), from = C.addDays(today, -1);
  return DB.events.filter(e => e.rem && e.rem.length && (e.repeat !== 'none' || e.date >= from)).map(e => {
    const done = Object.keys(DB.done).filter(k => k.startsWith(e.id + '@')).map(k => k.split('@')[1]);
    return { i: e.id, t: e.title.slice(0, 60), e: C.CATS[e.cat].e, h: e.cat === 'homework' ? 1 : 0, d: e.date, s: e.allDay ? null : e.start, r: e.repeat[0], x: [...new Set([...(e.ex || []), ...done])].filter(k => k >= from).sort().slice(-30), m: e.rem.slice(0, 7) };
  });
}
async function postEvents(sub, ev) {
  const v = Date.now(); const base = { type: 'sync', v, sub: sub.toJSON(), tz: tz() };
  for (let n = 1; n <= 30; n++) {
    const size = Math.ceil(ev.length / n) || 1; const parts = [];
    for (let i = 0; i < Math.max(ev.length, 1); i += size) parts.push(ev.slice(i, i + size));
    const bodies = await Promise.all(parts.map((chunk, i) => P.sealed({ ...base, part: i, parts: parts.length, ev: chunk })));
    if (bodies.every(b => b.length <= 4000)) { for (const b of bodies) await P.post(null, b); return parts.length; }
    if (size === 1) throw new Error('an event is too long to sync');
  }
  throw new Error('too many reminders to sync');
}

let syncing = null, again = false;
const NXRem = {
  available: supported,
  enabled: () => supported() && !!st().on && Notification.permission === 'granted',
  active: () => NXRem.enabled(),
  count: () => window.NXCal.DB.events.filter(e => e.rem && e.rem.length).length,
  async ensure() {
    if (!supported()) throw new Error("This browser can't do push notifications. Use Chrome on Android.");
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') { setSt({ ...st(), on: false }); throw new Error('Notifications are blocked for this site. Chrome: tap ⓘ / 🔒 by the address → Permissions → Notifications → Allow. Then try again.'); }
    const r = await reg(); let sub = await r.pushManager.getSubscription();
    if (sub && !sameKey(sub)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: P.b64u.dec(P.VAPID_PUBLIC) });
    const wasOn = st().on; setSt({ ...st(), on: true, endpoint: sub.endpoint }); await saveCfg(sub, true);
    await NXRem.sync(true);
    if (!wasOn) window.NXCal.toast('🔔 Reminders are on');
    refreshSettings();
  },
  async sync(force) {
    if (!NXRem.enabled()) return;
    if (syncing) { again = true; return syncing; }
    syncing = (async () => {
      try {
        const r = await reg(); const sub = await r.pushManager.getSubscription();
        if (!sub) { setSt({ ...st(), on: false }); refreshSettings(); return; }
        const ev = compact(); const sig = JSON.stringify([sub.endpoint, tz(), ev]);
        const s = st();
        if (!force && s.sig === sig && Date.now() - (s.syncedAt || 0) < 20 * 3600e3) return;
        if (!navigator.onLine) { setSt({ ...s, pending: true }); refreshSettings(); return; }
        await postEvents(sub, ev);
        setSt({ ...st(), sig, syncedAt: Date.now(), pending: false, err: null, endpoint: sub.endpoint });
      } catch (e) { setSt({ ...st(), pending: true, err: String(e.message || e) }); console.warn('reminder sync failed', e); }
      finally { refreshSettings(); }
    })();
    try { await syncing; } finally { syncing = null; if (again) { again = false; NXRem.sync(); } }
  },
  async test() {
    const r = await reg(); const sub = await r.pushManager.getSubscription(); if (!sub) throw new Error('Turn reminders on first');
    await NXRem.sync(true);
    await P.post({ type: 'test', v: Date.now(), sub: sub.toJSON(), tz: tz() });
    setSt({ ...st(), testAt: Date.now() });
  },
  async off() {
    try { const r = await reg(); const sub = await r.pushManager.getSubscription(); if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe(); P.post({ type: 'unsub', endpoint }).catch(() => {}); } } catch {}
    setSt({ on: false }); await saveCfg(null, false); refreshSettings();
  },
  settingsHtml() {
    if (!supported()) return `<div class="set-group"><div class="switch"><span class="lbl">🔔 Reminders<small>This browser can't do push notifications. Open the app in Chrome.</small></span></div></div>`;
    return `<div class="set-group" id="remGroup">${groupInner()}</div>`;
  },
  mountSettings(sh) {
    const g = sh.querySelector('#remGroup'); if (!g) return;
    g.addEventListener('click', async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.id === 'remTog') {
        if (NXRem.enabled()) { await NXRem.off(); window.NXCal.toast('Reminders off for this phone'); window.NXCal.render(); }
        else { t.disabled = true; try { await NXRem.ensure(); window.NXCal.render(); } catch (er) { window.NXCal.toast(er.message); } finally { t.disabled = false; refreshSettings(); } }
      } else if (t.id === 'remTest') {
        t.disabled = true; t.textContent = 'Sending…';
        try { await NXRem.test(); window.NXCal.toast('Test sent. It should pop up within about a minute'); } catch (er) { window.NXCal.toast(er.message); }
        finally { t.disabled = false; t.textContent = 'Send test'; refreshSettings(); }
      }
    });
  }
};
function groupInner() {
  const on = NXRem.enabled(), s = st(), n = NXRem.count();
  const blocked = Notification.permission === 'denied';
  const status = blocked ? 'Blocked in Chrome. Tap ⓘ by the address → Permissions → Notifications → Allow.'
    : !on ? 'Off. Turn on, then pick "Remind me" times on any event.'
    : s.err && s.pending ? `Couldn't sync yet (${esc(s.err)}). Will retry.`
    : s.pending ? 'Will sync when you are back online.'
    : `${n} event${n === 1 ? '' : 's'} with reminders${s.syncedAt ? ' · synced ' + new Date(s.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}`;
  return `<div class="switch"><span class="lbl">🔔 Reminder notifications<small id="remStatus">${status}</small></span><button type="button" class="tog" id="remTog" role="switch" aria-checked="${on}" aria-label="Reminder notifications"></button></div>` +
    (on ? `<div class="switch"><span class="lbl">Test it<small>Sends a notification to this phone in about a minute</small></span><button type="button" class="chip-btn" id="remTest">Send test</button></div>` : '');
}
function refreshSettings() { const g = $('#remGroup'); if (g) g.innerHTML = groupInner(); }

let t = null;
document.addEventListener('nxcal:changed', () => { clearTimeout(t); t = setTimeout(() => NXRem.sync(), 1200); });
window.addEventListener('online', () => { if (st().pending) NXRem.sync(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) NXRem.sync(); });
window.NXRem = NXRem;
if (supported() && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'nxcal-push') window.__lastPush = e.data; });
  // keep the subscription fresh on every open (cheap: skipped when nothing changed)
  setTimeout(() => { if (st().on && Notification.permission !== 'granted') { setSt({ ...st(), on: false }); } else NXRem.sync(); }, 1500);
}
})();
