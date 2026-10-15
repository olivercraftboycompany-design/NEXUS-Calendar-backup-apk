// NEXUS Calendar reminder sender. Runs in GitHub Actions (see .github/workflows/calendar-reminders.yml).
// One quick pass ("check" job), then a watch loop (LOOP_MINUTES) that checks every minute and hands off to the next run.
// Reads sealed reminder syncs from a private ntfy.sh topic and sends Web Push (VAPID) notifications at the right time.
// State (subscriptions + events with reminders + what was already sent) is encrypted and kept in the Actions cache, never in the repo.
import webpush from 'web-push';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const env = process.env;
const TOPIC = env.NTFY_TOPIC;
const STATE_FILE = path.join(env.STATE_DIR || '.state', 'state.bin');
const DRY = env.DRY_RUN === 'true';
const NOW_SHIFT = env.NOW_OVERRIDE ? Date.parse(env.NOW_OVERRIDE) - Date.now() : 0; // local testing only
let NOW = Date.now() + NOW_SHIFT;
const LOOP_MINUTES = +env.LOOP_MINUTES || 0;
const TICK_MS = (+env.TICK_SECONDS || 60) * 1000;
const ALLDAY_AT = 8 * 60; // all-day events: reminders count from 8:00 AM
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const k of ['VAPID_PUBLIC', 'VAPID_PRIVATE', 'BOX_PRIVATE', 'NTFY_TOPIC']) if (!env[k]) { console.error('Missing ' + k); process.exit(1); }
webpush.setVapidDetails('mailto:noreply@github.com', env.VAPID_PUBLIC, env.VAPID_PRIVATE);

/* ---------- crypto ---------- */
const b64u = s => Buffer.from(s, 'base64url');
const boxPriv = b64u(env.BOX_PRIVATE);
export function open(sealed) {
  const [v, eph, iv, ct] = String(sealed).trim().split('.');
  if ((v !== 'nc1' && v !== 'nc2') || !ct) throw new Error('not an nc1/nc2 message');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(boxPriv);
  const key = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(b64u(eph)), Buffer.alloc(0), Buffer.from('nxcal-box-v1'), 32));
  const data = b64u(ct), tag = data.subarray(data.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, b64u(iv)); d.setAuthTag(tag);
  let plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  if (v === 'nc2') plain = zlib.inflateRawSync(plain);
  return JSON.parse(plain.toString('utf8'));
}
const stateKey = crypto.createHash('sha256').update(Buffer.concat([boxPriv, Buffer.from('nxcal-state-v1')])).digest();
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE); const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28);
    const d = crypto.createDecipheriv('aes-256-gcm', stateKey, iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch (e) { log('no previous state (' + (e.code || e.message) + ')'); return {}; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', stateKey, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(s)), c.final()]);
  fs.writeFileSync(STATE_FILE, Buffer.concat([iv, c.getAuthTag(), ct]));
}
const idOf = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 12);

/* ---------- time zones ---------- */
const pad = n => String(n).padStart(2, '0');
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, key: `${o.year}-${o.month}-${o.day}` };
}
const offsetOf = (ms, tz) => { const p = partsIn(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
function zonedEpoch(key, minutes, tz) { // local wall time in tz -> epoch ms
  const [y, m, d] = key.split('-').map(Number); const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = guess - offsetOf(guess, tz); t = guess - offsetOf(t, tz); return t;
}
const addDays = (k, n) => { const [y, m, d] = k.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00Z') - Date.parse(a + 'T00:00Z')) / 864e5);
const toMin = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const fmtT = m => { let h = Math.floor(m / 60); const mm = m % 60; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return mm ? `${h}:${pad(mm)} ${ap}` : `${h} ${ap}`; };
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/* ---------- recurrence (same rules as the app) ---------- */
function occurrences(ev, from, to) {
  const out = [], ex = new Set(ev.x || []);
  const push = k => { if (k >= from && k <= to && k >= ev.d && !ex.has(k)) out.push(k); };
  if (ev.r === 'n') push(ev.d);
  else if (ev.r === 'd') { for (let k = ev.d > from ? ev.d : from; k <= to; k = addDays(k, 1)) push(k); }
  else if (ev.r === 'w') { let k = ev.d; if (k < from) k = addDays(k, Math.ceil(dayDiff(k, from) / 7) * 7); for (; k <= to; k = addDays(k, 7)) push(k); }
  else if (ev.r === 'm') {
    const day = +ev.d.slice(8, 10); const f = (from > ev.d ? from : ev.d); let y = +f.slice(0, 4), mo = +f.slice(5, 7);
    for (let i = 0; i < 14; i++, mo++) { if (mo > 12) { mo = 1; y++; } const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); if (day > last) continue; const k = `${y}-${pad(mo)}-${pad(day)}`; if (k > to) break; push(k); }
  }
  return out;
}
const sanitizeEv = e => ({ i: String(e.i || '').slice(0, 40), t: String(e.t || 'Event').slice(0, 80), e: String(e.e || '📅').slice(0, 8), h: e.h ? 1 : 0, d: /^\d{4}-\d{2}-\d{2}$/.test(e.d) ? e.d : null, s: /^\d{2}:\d{2}$/.test(e.s || '') ? e.s : null, r: 'ndwm'.includes(e.r) && e.r ? e.r : 'n', x: Array.isArray(e.x) ? e.x.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).slice(0, 60) : [], m: Array.isArray(e.m) ? [...new Set(e.m.map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 20160))].slice(0, 7) : [] });

/* ---------- inbox ---------- */
async function readInbox(state, verbose) {
  const since = state.since || 'all'; let txt = '';
  try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000); const r = await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${encodeURIComponent(since)}`, { signal: ac.signal }); clearTimeout(t); txt = r.ok ? await r.text() : ''; if (!r.ok) log('ntfy', r.status); }
  catch (e) { log('ntfy read failed', e.message); return []; }
  const msgs = txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(m => m && m.event === 'message');
  const out = [];
  for (const m of msgs) { state.since = m.id; try { const p = open(m.message); p._at = m.time * 1000; out.push(p); } catch { log('skipped a message we could not open'); } }
  if (verbose || msgs.length) log(`ntfy: ${msgs.length} new message(s), ${out.length} readable`);
  return out;
}
function absorb(state, m) {
  if (m.type === 'unsub') { const sid = m.endpoint && idOf(m.endpoint); if (sid && state.subs[sid]) { delete state.subs[sid]; log('unsubscribed', sid); } return; }
  if (!m.sub || !m.sub.endpoint || !m.sub.keys || !/^https:\/\//.test(m.sub.endpoint)) return;
  const sid = idOf(m.sub.endpoint); const prev = state.subs[sid] || {};
  if (m.type === 'resub' && m.old) { const osid = idOf(m.old); if (state.subs[osid] && osid !== sid) { Object.assign(prev, state.subs[osid], prev); delete state.subs[osid]; log(`moved reminders ${osid} → ${sid}`); } }
  const s = state.subs[sid] = { ...prev, sub: m.sub, tz: validTz(m.tz) ? m.tz : (prev.tz || 'America/Chicago'), at: Math.max(prev.at || 0, m._at || 0), ev: prev.ev || [], sent: prev.sent || {} };
  if (m.type === 'sync') {
    const v = +m.v || 0; if (v < (s.v || 0)) { log(`ignored an older sync for ${sid}`); return; }
    s.pend = s.pend && s.pend.v === v ? s.pend : { v, n: +m.parts || 1, got: {} };
    s.pend.got[+m.part || 0] = (Array.isArray(m.ev) ? m.ev : []).map(sanitizeEv).filter(e => e.i && e.d && e.m.length);
    if (Object.keys(s.pend.got).length >= s.pend.n) { s.ev = Object.values(s.pend.got).flat(); s.v = v; delete s.pend; log(`${prev.sub ? 'updated' : 'new'} device ${sid}: ${s.ev.length} event(s) with reminders, tz ${s.tz}`); }
    else log(`device ${sid}: sync part ${Object.keys(s.pend.got).length}/${s.pend.n}`);
  } else if (m.type === 'test') { s.testPending = true; log(`test requested by ${sid}`); }
}

/* ---------- push ---------- */
async function push(state, sid, n, opts = {}) {
  const s = state.subs[sid]; if (!s) return false;
  const body = JSON.stringify({ ...n, ts: NOW });
  if (DRY) { log('[dry] would push to', sid, body); return true; }
  try {
    const r = await webpush.sendNotification(s.sub, body, { TTL: opts.ttl ?? 3600, urgency: opts.urgency || 'high' });
    log(`pushed "${n.title}" to ${sid} → ${r.statusCode}`); s.lastOk = NOW; s.fails = 0; return true;
  } catch (e) {
    log(`push to ${sid} failed: ${e.statusCode || ''} ${e.body || e.message}`);
    if (e.statusCode === 404 || e.statusCode === 410) { log('subscription expired, removing', sid); delete state.subs[sid]; }
    else s.fails = (s.fails || 0) + 1;
    return false;
  }
}
function remLabel(m) { return m === 0 ? 'at start' : m < 60 ? `${m} min before` : m < 1440 ? `${m / 60} hr before` : m < 10080 ? `${m / 1440} day before` : '1 week before'; }
function bodyFor(ev, key, startMs, tz) {
  const today = partsIn(NOW, tz).key; const dd = dayDiff(today, key); const mins = Math.round((startMs - NOW) / 60000);
  const dayWord = dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : dd === -1 ? 'Yesterday' : new Date(Date.parse(key + 'T12:00Z')).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!ev.s) return ev.h ? `Due ${dayWord.toLowerCase() === 'today' ? 'today' : dayWord === 'Tomorrow' ? 'tomorrow' : dayWord}` : `${dayWord} · all day`;
  const at = fmtT(toMin(ev.s));
  if (mins <= 0 && mins > -15) return `Starting now · ${at}`;
  if (mins > 0 && mins < 60) return `Starts in ${mins} min · ${at}`;
  if (mins >= 60 && dd === 0) { const h = Math.floor(mins / 60), r = mins % 60; return `Starts in ${h} hr${r ? ' ' + r + ' min' : ''} · ${at}`; }
  return `${dayWord} at ${at}`;
}

/* ---------- reminders ---------- */
async function checkReminders(state, sid, verbose) {
  const s = state.subs[sid]; const tz = s.tz || 'America/Chicago'; const today = partsIn(NOW, tz).key;
  let due = 0, sentNow = 0;
  for (const ev of s.ev || []) {
    for (const key of occurrences(ev, addDays(today, -1), addDays(today, 8))) {
      const startMs = zonedEpoch(key, ev.s ? toMin(ev.s) : ALLDAY_AT, tz);
      for (const m of ev.m) {
        const fireAt = startMs - m * 60000; const k = `${ev.i}@${key}@${m}`;
        if (fireAt > NOW || s.sent[k]) continue;
        // never send a reminder for something already over; tolerate a late start of up to 15 min for "at start"
        const lateBy = NOW - fireAt; const ok = lateBy < 6 * 3600e3 && (NOW < startMs || NOW - startMs < 15 * 60000);
        if (!ok) { s.sent[k] = -NOW; continue; } // too late: mark skipped so it is never sent
        due++;
        const done = await push(state, sid, { title: `${ev.e} ${ev.t}`, body: bodyFor(ev, key, startMs, tz) + (lateBy > 10 * 60000 ? ' (reminder ran late)' : ''), tag: `nxcal-${ev.i}-${key}`, url: `./#ev=${encodeURIComponent(ev.i + '@' + key)}` }, { ttl: Math.max(300, Math.min(24 * 3600, Math.round((startMs - NOW) / 1000) + 900)) });
        if (!state.subs[sid]) return;
        log(`  reminder "${ev.t}" ${key} ${remLabel(m)} (due ${new Date(fireAt).toISOString().slice(11, 16)}Z, ${Math.round(lateBy / 1000)}s late) → ${done ? 'sent' : 'failed'}`);
        if (done) { s.sent[k] = NOW; sentNow++; }
      }
    }
  }
  if (s.testPending) {
    const n = (s.ev || []).length; let next = null;
    for (const ev of s.ev || []) for (const key of occurrences(ev, today, addDays(today, 8))) for (const m of ev.m) { const f = zonedEpoch(key, ev.s ? toMin(ev.s) : ALLDAY_AT, tz) - m * 60000; if (f > NOW && (!next || f < next.f)) next = { f, ev }; }
    const nextTxt = next ? ` Next one: "${next.ev.t}" ${dayDiff(today, partsIn(next.f, tz).key) === 0 ? 'today' : dayDiff(today, partsIn(next.f, tz).key) === 1 ? 'tomorrow' : 'on ' + partsIn(next.f, tz).key.slice(5).replace('-', '/')} at ${fmtT(partsIn(next.f, tz).h * 60 + partsIn(next.f, tz).mi)}.` : '';
    const ok = await push(state, sid, { title: '🔔 Reminders are working', body: `${n} event${n === 1 ? '' : 's'} with reminders on this phone.${nextTxt}`, tag: 'nxcal-test', url: './' }, { ttl: 900 });
    log(`  test → ${ok ? 'sent' : 'failed'} (${n} events, next ${next ? new Date(next.f).toISOString() : 'none'})`);
    if (state.subs[sid]) delete state.subs[sid].testPending;
  }
  // forget sent marks older than 10 days
  for (const [k, t] of Object.entries(s.sent)) if (NOW - Math.abs(t) > 10 * 864e5) delete s.sent[k];
  if (verbose) log(`  ${sid}: ${(s.ev || []).length} event(s), tz ${tz}, ${sentNow} sent this pass`);
}

/* ---------- main ---------- */
const state = loadState(); state.subs ||= {};
async function cycle(verbose) {
  NOW = Date.now() + NOW_SHIFT;
  for (const m of await readInbox(state, verbose)) absorb(state, m);
  const ids = Object.keys(state.subs).sort((a, b) => (state.subs[b].at || 0) - (state.subs[a].at || 0));
  for (const sid of ids.slice(8)) delete state.subs[sid]; // keep the 8 most recent devices
  if (verbose) log(`${Object.keys(state.subs).length} device(s)`);
  for (const sid of Object.keys(state.subs)) { try { await checkReminders(state, sid, verbose); } catch (e) { log('check failed for', sid, e.message); } }
  state.lastRun = NOW; saveState(state);
}
const started = Date.now();
await cycle(true);
if (LOOP_MINUTES > 0) {
  log(`watching: one pass a minute for ${LOOP_MINUTES} min`);
  let n = 0;
  while (Date.now() - started + TICK_MS < LOOP_MINUTES * 60000) {
    // line the passes up with the top of each minute so a "10 min before" lands on time
    const wait = TICK_MS >= 60000 ? 60000 - ((Date.now() + NOW_SHIFT) % 60000) + 1500 : TICK_MS;
    await new Promise(r => setTimeout(r, wait));
    try { await cycle(false); } catch (e) { log('cycle failed', e.message); }
    if (++n % 15 === 0) log(`still watching (${Math.round((Date.now() - started) / 60000)} min)`);
  }
}
log('done');
