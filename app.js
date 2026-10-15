/* NEXUS Calendar. Everything lives in this phone's storage (localStorage); nothing is sent anywhere. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'nxcal_v1';

const CATS = {
  school:   { n: 'School',   e: '🏫', c: '#3b82f6' },
  test:     { n: 'Test',     e: '📝', c: '#ef4444' },
  homework: { n: 'Homework', e: '📚', c: '#f59e0b' },
  sports:   { n: 'Sports',   e: '🏀', c: '#22c55e' },
  church:   { n: 'Church',   e: '⛪', c: '#a855f7' },
  hangout:  { n: 'Hangout',  e: '🎉', c: '#ec4899' },
  other:    { n: 'Other',    e: '📌', c: '#06b6d4' }
};
const REPEAT = { none: 'Does not repeat', daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------- dates (all local, keyed YYYY-MM-DD) ---------- */
const pad = n => String(n).padStart(2, '0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dOf = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = dOf(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const diffDays = (a, b) => Math.round((dOf(b) - dOf(a)) / 864e5);
const toMin = t => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const fmtT = t => { const m = toMin(t); if (m == null) return ''; let h = Math.floor(m / 60), mm = m % 60; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return mm ? `${h}:${pad(mm)} ${ap}` : `${h} ${ap}`; };
const fmtDate = (k, long) => { const d = dOf(k); return long ? `${DOWL[d.getDay()]}, ${MONL[d.getMonth()]} ${d.getDate()}` : `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };
const relDay = k => { const n = diffDays(todayKey(), k); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : fmtDate(k); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- storage ---------- */
let DB = load();
function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && Array.isArray(v.events)) return { events: v.events, done: v.done || {}, settings: { holidays: true, weekStart: 0, view: 'month', ...(v.settings || {}) } };
  } catch (e) { console.warn('could not read saved calendar', e); }
  return { events: [], done: {}, settings: { holidays: true, weekStart: 0, view: 'month' } };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch (e) { toast('Could not save: storage is full'); }
  document.dispatchEvent(new CustomEvent('nxcal:changed'));
}
const cleanEvent = e => {
  const out = {
    id: String(e.id || uid()), title: String(e.title || 'Untitled').slice(0, 120), cat: CATS[e.cat] ? e.cat : 'other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : todayKey(), allDay: !!e.allDay,
    start: /^\d{2}:\d{2}$/.test(e.start || '') ? e.start : null, end: /^\d{2}:\d{2}$/.test(e.end || '') ? e.end : null,
    repeat: REPEAT[e.repeat] ? e.repeat : 'none', notes: String(e.notes || '').slice(0, 2000),
    ex: Array.isArray(e.ex) ? e.ex.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) : [],
    rem: Array.isArray(e.rem) ? e.rem.map(Number).filter(n => n >= 0 && n <= 20160) : [],
    created: e.created || Date.now(), updated: e.updated || Date.now()
  };
  if (!out.start) out.allDay = true;
  if (out.allDay) { out.start = null; out.end = null; }
  if (!out.allDay && (!out.end || toMin(out.end) <= toMin(out.start))) out.end = fromMin(Math.min(toMin(out.start) + 60, 23 * 60 + 59));
  return out;
};

/* ---------- recurrence ---------- */
function occurrences(from, to) {
  const out = [];
  for (const ev of DB.events) {
    const ex = new Set(ev.ex || []);
    const push = k => { if (k >= from && k <= to && k >= ev.date && !ex.has(k)) out.push({ ev, key: k }); };
    if (ev.repeat === 'none') push(ev.date);
    else if (ev.repeat === 'daily') { for (let k = ev.date > from ? ev.date : from; k <= to; k = addDays(k, 1)) push(k); }
    else if (ev.repeat === 'weekly') {
      let k = ev.date;
      if (k < from) k = addDays(k, Math.ceil(diffDays(k, from) / 7) * 7);
      for (; k <= to; k = addDays(k, 7)) push(k);
    } else if (ev.repeat === 'monthly') {
      const day = dOf(ev.date).getDate(); const f = dOf(from > ev.date ? from : ev.date);
      for (let y = f.getFullYear(), m = f.getMonth(); ; m++) {
        const d = new Date(y, m, day); if (d.getDate() !== day) { if (keyOf(new Date(y, m, 1)) > to) break; continue; }
        const k = keyOf(d); if (k > to) break; push(k);
      }
    }
  }
  return out.sort(cmpOcc);
}
const cmpOcc = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : (a.ev.allDay === b.ev.allDay ? (toMin(a.ev.start) || 0) - (toMin(b.ev.start) || 0) || a.ev.title.localeCompare(b.ev.title) : a.ev.allDay ? -1 : 1);
const byDay = (from, to) => { const m = {}; for (const o of occurrences(from, to)) (m[o.key] = m[o.key] || []).push(o); return m; };
const isDone = (ev, k) => !!DB.done[ev.id + '@' + k];

/* ---------- US holidays ---------- */
const holCache = {};
function holidays(y) {
  if (holCache[y]) return holCache[y];
  const H = {}; const add = (d, n, e) => { (H[keyOf(d)] = H[keyOf(d)] || []).push({ n, e }); };
  const nth = (m, wd, n) => { const d = new Date(y, m, 1); d.setDate(1 + (wd - d.getDay() + 7) % 7 + (n - 1) * 7); return d; };
  const last = (m, wd) => { const d = new Date(y, m + 1, 0); d.setDate(d.getDate() - (d.getDay() - wd + 7) % 7); return d; };
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451), em = Math.floor((h + l - 7 * mm + 114) / 31), ed = ((h + l - 7 * mm + 114) % 31) + 1;
  add(new Date(y, 0, 1), "New Year's Day", '🎆'); add(nth(0, 1, 3), 'MLK Jr. Day', '✊'); add(new Date(y, 1, 14), "Valentine's Day", '💘');
  add(nth(1, 1, 3), "Presidents' Day", '🇺🇸'); add(new Date(y, 2, 17), "St. Patrick's Day", '☘️');
  const easter = new Date(y, em - 1, ed); const gf = new Date(easter); gf.setDate(gf.getDate() - 2);
  add(gf, 'Good Friday', '✝️'); add(easter, 'Easter', '✝️'); add(nth(4, 0, 2), "Mother's Day", '💐'); add(last(4, 1), 'Memorial Day', '🇺🇸');
  add(nth(5, 0, 3), "Father's Day", '👔'); add(new Date(y, 5, 19), 'Juneteenth', '🇺🇸'); add(new Date(y, 6, 4), 'Independence Day', '🎆');
  add(nth(8, 1, 1), 'Labor Day', '🇺🇸'); add(nth(9, 1, 2), 'Columbus Day', '🇺🇸'); add(new Date(y, 9, 31), 'Halloween', '🎃');
  add(new Date(y, 10, 11), 'Veterans Day', '🎖️'); add(nth(10, 4, 4), 'Thanksgiving', '🦃'); add(new Date(y, 11, 24), 'Christmas Eve', '🎄');
  add(new Date(y, 11, 25), 'Christmas', '🎄'); add(new Date(y, 11, 31), "New Year's Eve", '🥳');
  return (holCache[y] = H);
}
const holsOn = k => DB.settings.holidays ? (holidays(+k.slice(0, 4))[k] || []) : [];

/* ---------- quick add parser ---------- */
const WD = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
const MO = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
const CAT_WORDS = [
  ['test', /\b(test|quiz|exam|final|finals|midterm|ap test|psat)\b/],
  ['homework', /\b(hw|homework|assignment|essay|worksheet|project|due|lab report|reading|study guide|paper)\b/],
  ['sports', /\b(practice|game|match|meet|tournament|tourney|scrimmage|football|basketball|baseball|softball|soccer|volleyball|wrestling|track|cross country|xc|tennis|golf|swim|lifting|weights|gym|workout)\b/],
  ['church', /\b(church|youth group|youth|bible study|bible|mass|worship|service|small group|wednesday night|vbs|retreat|prayer)\b/],
  ['hangout', /\b(hang|hangout|hang out|party|movie|movies|sleepover|birthday|bday|chill|game night|with friends|date|concert|mall)\b/],
  ['school', /\b(school|class|club|period|meeting|conference|orientation|dance|homecoming|prom|assembly|field trip|band|choir|robotics)\b/]
];
function parseTime(tok, next) {
  let t = tok.toLowerCase(), used = 1;
  if (t === 'noon') return { m: 720, used };
  if (t === 'midnight') return { m: 0, used };
  if (next && /^(am|pm|a\.m\.|p\.m\.)$/.test(next.toLowerCase())) { t += next.toLowerCase().replace(/\./g, ''); used = 2; }
  const r = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
  if (!r) return null;
  let h = +r[1]; const mi = r[2] ? +r[2] : 0; const ap = r[3] ? r[3][0] : null;
  if (h > 23 || mi > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = h % 12 + (ap === 'p' ? 12 : 0); }
  return { m: h * 60 + mi, used, ap: !!ap, colon: !!r[2], h12: !ap && h <= 12 };
}
const guessAmPm = h => (h >= 1 && h <= 7) ? h + 12 : h; // "at 7" -> 7 PM, "at 9" -> 9 AM
function parseQuick(text, now = new Date()) {
  const raw = text.trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  const toks = raw.split(' '); const used = new Array(toks.length).fill(false);
  const low = toks.map(t => t.toLowerCase().replace(/[,.!?]+$/, ''));
  const today = keyOf(now); let date = null, start = null, end = null, repeat = 'none', explicitTime = false;
  const upcoming = wd => addDays(today, (wd - now.getDay() + 7) % 7);
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    const w = low[i], nx = low[i + 1];
    const mark = (...ix) => ix.forEach(j => { used[j] = true; });
    // repeat words
    if (w === 'daily' || (w === 'every' && (nx === 'day' || nx === 'night'))) { repeat = 'daily'; mark(i); if (w === 'every') mark(i + 1); continue; }
    if (w === 'weekly') { repeat = 'weekly'; mark(i); continue; }
    if (w === 'monthly' || (w === 'every' && nx === 'month')) { repeat = 'monthly'; mark(i); if (w === 'every') mark(i + 1); continue; }
    if (w === 'every' && nx && WD[nx.replace(/s$/, '')] != null) { repeat = 'weekly'; date = upcoming(WD[nx.replace(/s$/, '')]); mark(i, i + 1); i++; continue; }
    if (w === 'every' && nx === 'week') { repeat = 'weekly'; mark(i, i + 1); continue; }
    // relative days
    if (w === 'today' || w === 'tonight' || w === 'tonite') { date = today; mark(i); continue; }
    if (['tomorrow', 'tmrw', 'tmr', 'tomorow', 'tommorow', 'tomm'].includes(w)) { date = addDays(today, 1); mark(i); continue; }
    if ((w === 'next' || w === 'this') && nx && WD[nx] != null) { let u = upcoming(WD[nx]); if (w === 'next' && (u === today || WD[nx] > now.getDay())) u = addDays(u, 7); date = u; mark(i, i + 1); i++; continue; }
    if (w === 'next' && nx === 'week') { date = addDays(today, 7); mark(i, i + 1); i++; continue; }
    if (WD[w] != null && !(toks[i] === 'SAT')) { date = upcoming(WD[w]); mark(i); if (i > 0 && ['on', 'this'].includes(low[i - 1])) mark(i - 1); continue; }
    if (/^(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s$/.test(w) && i > 0) { repeat = 'weekly'; date = upcoming(WD[w.slice(0, -1)]); mark(i); continue; }
    // month name dates: oct 20 / october 20th
    if (MO[w] != null && nx && /^\d{1,2}(st|nd|rd|th)?$/.test(nx)) {
      const m = MO[w], d = parseInt(nx, 10); let y = now.getFullYear(); let dt = new Date(y, m, d);
      if (keyOf(dt) < addDays(today, -30)) dt = new Date(y + 1, m, d);
      if (dt.getDate() === d) { date = keyOf(dt); mark(i, i + 1); if (i > 0 && low[i - 1] === 'on') mark(i - 1); i++; continue; }
    }
    // 10/20 or 10/20/26
    let r = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (r) {
      let y = r[3] ? (+r[3] < 100 ? 2000 + +r[3] : +r[3]) : now.getFullYear(); let dt = new Date(y, +r[1] - 1, +r[2]);
      if (!r[3] && keyOf(dt) < addDays(today, -30)) dt = new Date(y + 1, +r[1] - 1, +r[2]);
      if (dt.getDate() === +r[2]) { date = keyOf(dt); mark(i); if (i > 0 && low[i - 1] === 'on') mark(i - 1); continue; }
    }
    // the 20th
    r = w.match(/^(\d{1,2})(st|nd|rd|th)$/);
    if (r) { const d = +r[1]; let dt = new Date(now.getFullYear(), now.getMonth(), d); if (keyOf(dt) < today) dt = new Date(now.getFullYear(), now.getMonth() + 1, d); if (dt.getDate() === d) { date = keyOf(dt); mark(i); if (i > 0 && ['the', 'on'].includes(low[i - 1])) mark(i - 1); if (i > 1 && low[i - 1] === 'the' && low[i - 2] === 'on') mark(i - 2); continue; } }
    // time ranges: 7-9pm, 7pm-9pm, 7:30-8:30pm
    r = w.match(/^(\d{1,2}(?::\d{2})?(?:am|pm|a|p)?)[-–](\d{1,2}(?::\d{2})?(?:am|pm|a|p)?)$/);
    if (r) {
      const a = parseTime(r[1]), b = parseTime(r[2], /^(am|pm)$/.test(nx || '') ? nx : null);
      if (a && b) {
        let s = a.m, e = b.m;
        if (!a.ap && b.ap) { const alt = s + 12 * 60; if (s + 720 < e && alt < 24 * 60) s = alt; else if (s > e && s < 720) s = s; }
        if (!a.ap && !b.ap) { s = guessAmPm(Math.floor(s / 60)) * 60 + s % 60; e = guessAmPm(Math.floor(e / 60)) * 60 + e % 60; }
        if (e <= s) e = Math.min(s + 60, 1439);
        start = s; end = e; explicitTime = true; mark(i); if (b && /^(am|pm)$/.test(nx || '')) mark(i + 1);
        if (i > 0 && ['at', 'from', '@'].includes(low[i - 1])) mark(i - 1); continue;
      }
    }
    // single time (+ optional "to 9pm")
    const pt = parseTime(w, nx);
    if (pt && (pt.ap || pt.colon || ['at', '@', 'from', 'tonight', 'tonite'].includes(low[i - 1]) || ['noon', 'midnight'].includes(w))) {
      let m = pt.m; if (!pt.ap && pt.h12 && !['noon', 'midnight'].includes(w)) m = guessAmPm(Math.floor(m / 60)) * 60 + m % 60;
      const target = start == null ? 'start' : 'end';
      if (target === 'start') start = m; else end = m;
      explicitTime = true; for (let j = 0; j < pt.used; j++) used[i + j] = true;
      if (i > 0 && ['at', '@', 'from', 'to', 'until', 'till', '-'].includes(low[i - 1])) used[i - 1] = true;
      i += pt.used - 1; continue;
    }
  }
  if (start != null && end != null && end <= start) { if (end + 720 > start && end < 720) end += 720; if (end <= start) end = Math.min(start + 60, 1439); }
  // title = leftover words
  const fillers = new Set(['at', 'on', 'from', 'to', 'until', 'till', '@', '-', 'by', 'the']);
  let words = toks.filter((_, i) => !used[i]);
  while (words.length && fillers.has(words[words.length - 1].toLowerCase())) words.pop();
  while (words.length && fillers.has(words[0].toLowerCase())) words.shift();
  let title = words.join(' ').replace(/\s+([,.!?])/g, '$1').replace(/[,]+$/, '').trim();
  if (!title) title = 'New event';
  title = title[0].toUpperCase() + title.slice(1);
  const lt = ' ' + raw.toLowerCase() + ' ';
  let cat = /\b(SAT|ACT|PSAT)\b/.test(raw) ? 'test' : 'other'; if (cat === 'other') for (const [c, re] of CAT_WORDS) if (re.test(lt)) { cat = c; break; }
  if (!date) date = (start != null && start < now.getHours() * 60 + now.getMinutes() - 30) ? addDays(today, 1) : today;
  return cleanEvent({ title, cat, date, allDay: start == null, start: start != null ? fromMin(start) : null, end: end != null ? fromMin(end) : null, repeat });
}

/* ---------- UI state ---------- */
const UI = { view: ['month', 'week', 'day', 'agenda'].includes(DB.settings.view) ? DB.settings.view : 'month', cursor: todayKey(), sel: todayKey() };
const evWhen = (ev, k, withDay) => {
  const day = withDay ? relDay(k) + ' · ' : '';
  return ev.allDay ? day + (ev.cat === 'homework' ? 'Due' : 'All day') : day + fmtT(ev.start) + (ev.end ? '–' + fmtT(ev.end) : '');
};
function evRow(o, opts = {}) {
  const { ev, key } = o; const c = CATS[ev.cat]; const hw = ev.cat === 'homework'; const done = hw && isDone(ev, key);
  const sub = [evWhen(ev, key, opts.withDay), ev.repeat !== 'none' ? '🔁 ' + REPEAT[ev.repeat].toLowerCase() : '', ev.rem && ev.rem.length && window.NXRem && window.NXRem.active() ? '🔔' : '', ev.notes ? ev.notes.split('\n')[0] : ''].filter(Boolean).join(' · ');
  return `<div class="ev${done ? ' done' : ''}" style="--c:${c.c}" data-open="${esc(ev.id)}" data-key="${key}" role="button" tabindex="0">
    ${hw ? `<button type="button" class="chk${done ? ' on' : ''}" data-done="${esc(ev.id)}" data-key="${key}" aria-label="${done ? 'Mark not done' : 'Mark done'}">${done ? '✓' : ''}</button>` : `<span class="em">${c.e}</span>`}
    <span class="tx"><div class="t">${esc(ev.title)}</div><div class="s">${esc(sub)}</div></span></div>`;
}
const holRow = h => `<div class="ev hol"><span class="em">${h.e}</span><span class="tx"><div class="t">${esc(h.n)}</div><div class="s">US holiday</div></span></div>`;

/* ---------- views ---------- */
function setTitle(t) { $('#calTitle').textContent = t; }
function renderMonth() {
  const cur = dOf(UI.cursor); const y = cur.getFullYear(), m = cur.getMonth();
  setTitle(`${MONL[m]} ${y}`);
  const first = new Date(y, m, 1); const ws = DB.settings.weekStart;
  const start = addDays(keyOf(first), -((first.getDay() - ws + 7) % 7));
  const end = addDays(start, 41); const map = byDay(start, end); const tk = todayKey();
  let h = '<div class="dow">' + [0, 1, 2, 3, 4, 5, 6].map(i => DOW[(i + ws) % 7].toUpperCase().slice(0, 2)).join('').replace(/([A-Z]{2})/g, '<span>$1</span>') + '</div><div class="month">';
  for (let i = 0; i < 42; i++) {
    const k = addDays(start, i); const d = dOf(k); const evs = map[k] || []; const hol = holsOn(k);
    const cls = ['mcell', d.getMonth() !== m && 'out', k === tk && 'today', k === UI.sel && 'sel', hol.length && 'hol'].filter(Boolean).join(' ');
    const dots = evs.slice(0, 4).map(o => `<i class="dot" style="--c:${CATS[o.ev.cat].c}"></i>`).join('') + (evs.length > 4 ? `<span class="more">+${evs.length - 4}</span>` : '');
    const label = `${fmtDate(k, true)}${evs.length ? ', ' + evs.length + ' event' + (evs.length > 1 ? 's' : '') : ''}${hol.length ? ', ' + hol.map(x => x.n).join(', ') : ''}`;
    h += `<button type="button" class="${cls}" data-day="${k}" aria-label="${esc(label)}"><span class="n">${d.getDate()}</span><span class="dots">${dots}${hol.length ? '<i class="dot hol"></i>' : ''}</span></button>`;
  }
  return h + '</div>';
}
function weekStartOf(k) { const d = dOf(k); return addDays(k, -((d.getDay() - DB.settings.weekStart + 7) % 7)); }
function renderWeek() {
  const s = weekStartOf(UI.cursor), e = addDays(s, 6); const ds = dOf(s), de = dOf(e);
  setTitle(ds.getMonth() === de.getMonth() ? `${MON[ds.getMonth()]} ${ds.getDate()}–${de.getDate()}` : `${MON[ds.getMonth()]} ${ds.getDate()} – ${MON[de.getMonth()]} ${de.getDate()}`);
  const map = byDay(s, e); const tk = todayKey(); let h = '';
  for (let i = 0; i < 7; i++) {
    const k = addDays(s, i), d = dOf(k); const evs = map[k] || []; const hol = holsOn(k);
    h += `<div class="wrow${k === tk ? ' today' : ''}"><button type="button" class="wday" data-goday="${k}" aria-label="Open ${fmtDate(k, true)}"><div class="d">${DOW[d.getDay()].toUpperCase()}</div><div class="n">${d.getDate()}</div></button><div class="wevs">${hol.map(holRow).join('')}${evs.map(o => evRow(o)).join('') || `<button type="button" class="wadd" data-addon="${k}">+ add</button>`}</div></div>`;
  }
  return h;
}
function renderDay() {
  const k = UI.cursor; setTitle(relDay(k) === fmtDate(k) ? fmtDate(k) : `${relDay(k)} · ${MON[dOf(k).getMonth()]} ${dOf(k).getDate()}`);
  const occ = occurrences(k, k); const allDay = occ.filter(o => o.ev.allDay); const timed = occ.filter(o => !o.ev.allDay);
  const HPX = 48; let h = `<div class="allday">${holsOn(k).map(holRow).join('')}${allDay.map(o => evRow(o)).join('')}</div>`;
  h += `<div class="dgrid" id="dgrid"><div class="dgrid-in" style="height:${24 * HPX}px">`;
  for (let i = 0; i < 24; i++) h += `<div class="hr" style="top:${i * HPX}px">${i ? `<span>${fmtT(fromMin(i * 60)).replace(' ', '')}</span>` : ''}</div>`;
  // overlap columns
  const items = timed.map(o => ({ o, s: toMin(o.ev.start), e: Math.max(toMin(o.ev.end) || 0, toMin(o.ev.start) + 30) }));
  const cols = []; let group = [], gEnd = -1;
  const flush = () => { const n = Math.max(1, ...group.map(g => g.col + 1)); group.forEach(g => { g.n = n; }); group = []; };
  for (const it of items) {
    if (it.s >= gEnd) { flush(); cols.length = 0; }
    let c = cols.findIndex(endM => endM <= it.s); if (c < 0) { c = cols.length; cols.push(it.e); } else cols[c] = it.e;
    it.col = c; group.push(it); gEnd = Math.max(gEnd, it.e);
  }
  flush();
  h += '<div class="dslot">';
  for (const it of items) {
    const ev = it.o.ev, c = CATS[ev.cat]; const w = 100 / it.n;
    h += `<button type="button" class="blk" style="--c:${c.c};top:${it.s / 60 * HPX}px;height:${Math.max((it.e - it.s) / 60 * HPX - 2, 22)}px;left:${it.col * w}%;width:calc(${w}% - 3px)" data-open="${esc(ev.id)}" data-key="${k}"><b>${c.e} ${esc(ev.title)}</b><span>${fmtT(ev.start)}${ev.end ? '–' + fmtT(ev.end) : ''}</span></button>`;
  }
  h += '</div>';
  if (k === todayKey()) { const n = new Date(); h += `<div class="nowline" style="top:${(n.getHours() * 60 + n.getMinutes()) / 60 * HPX}px"></div>`; }
  return h + '</div></div>';
}
function renderAgenda() {
  const s = UI.cursor < todayKey() ? UI.cursor : todayKey(); const e = addDays(UI.cursor, 60);
  setTitle('Upcoming'); const map = byDay(s, e); let h = ''; const tk = todayKey(); let n = 0;
  for (let k = s; k <= e; k = addDays(k, 1)) {
    const evs = map[k] || []; const hol = holsOn(k); if (!evs.length && !hol.length) continue;
    h += `<div class="ag-date${k === tk ? ' td' : ''}">${relDay(k) === fmtDate(k) ? fmtDate(k, true) : relDay(k) + ' · ' + fmtDate(k)}</div>` + hol.map(holRow).join('') + evs.map(o => evRow(o)).join('');
    n += evs.length;
  }
  return n || h ? h : `<div class="empty">Nothing in the next 60 days. Tap + or try quick add: "practice mon 3:30pm"</div>`;
}
function renderView(dir) {
  const v = $('#view');
  v.innerHTML = UI.view === 'month' ? renderMonth() : UI.view === 'week' ? renderWeek() : UI.view === 'day' ? renderDay() : renderAgenda();
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === UI.view)));
  $('#prevBtn').classList.toggle('hidden', UI.view === 'agenda'); $('#nextBtn').classList.toggle('hidden', UI.view === 'agenda');
  if (dir) { v.classList.remove('slide-l', 'slide-r'); void v.offsetWidth; v.classList.add(dir > 0 ? 'slide-l' : 'slide-r'); }
  if (UI.view === 'day') { const g = $('#dgrid'); if (g) { const n = new Date(); const firstTimed = occurrences(UI.cursor, UI.cursor).find(o => !o.ev.allDay); const startH = UI.cursor === todayKey() ? n.getHours() - 1 : firstTimed ? Math.floor(toMin(firstTimed.ev.start) / 60) - 1 : 7; g.scrollTop = Math.max(0, startH) * 48; } }
  renderDayPanel();
}
function renderDayPanel() {
  const p = $('#dayPanel'); if (UI.view !== 'month') { p.classList.add('hidden'); return; }
  p.classList.remove('hidden'); const k = UI.sel; const occ = occurrences(k, k); const hol = holsOn(k);
  p.innerHTML = `<div class="ph"><div><h2>${relDay(k) === fmtDate(k) ? fmtDate(k, true) : relDay(k)}</h2><div class="sub">${relDay(k) === fmtDate(k) ? '' : fmtDate(k, true)}</div></div><button type="button" class="add-mini" data-addon="${k}">+ Add</button></div>` +
    hol.map(holRow).join('') + (occ.length ? occ.map(o => evRow(o)).join('') : `<div class="empty">Nothing planned${hol.length ? '' : ' yet'}.</div>`);
}
function renderNextUp() {
  const now = new Date(); const tk = todayKey(); const nowM = now.getHours() * 60 + now.getMinutes();
  const occ = occurrences(tk, addDays(tk, 120)).filter(o => !(o.ev.cat === 'homework' && isDone(o.ev, o.key)));
  const next = occ.find(o => o.key > tk || (o.ev.allDay ? true : (toMin(o.ev.end) || toMin(o.ev.start)) > nowM));
  const el = $('#nextUp');
  if (!next) { el.innerHTML = `<div class="nu-emoji" style="--c:#3b82f6">🗓️</div><div class="nu-body"><div class="nu-label">NEXT UP</div><div class="nu-title">Nothing coming up</div><div class="nu-when">Type something like "youth group wed 7pm" above</div></div>`; return; }
  const { ev, key } = next; const c = CATS[ev.cat];
  let count = '', small = '';
  if (!ev.allDay && key === tk) {
    const s = toMin(ev.start), e = toMin(ev.end) || s + 60;
    if (s <= nowM && nowM < e) { count = 'NOW'; small = `ends ${fmtT(ev.end)}`; }
    else { const d = s - nowM; count = d >= 60 ? `${Math.floor(d / 60)}h ${d % 60}m` : `${d}m`; small = 'TO GO'; }
  } else { const d = diffDays(tk, key); count = d === 0 ? 'TODAY' : d === 1 ? 'TMRW' : `${d}d`; small = d > 1 ? 'AWAY' : ''; }
  el.innerHTML = `<div class="nu-emoji" style="--c:${c.c}">${c.e}</div><div class="nu-body"><div class="nu-label">NEXT UP</div><div class="nu-title">${esc(ev.title)}</div><div class="nu-when">${esc(evWhen(ev, key, true))}</div></div><div class="nu-count">${count}<small>${small}</small></div>`;
  el.dataset.open = ev.id; el.dataset.key = key; el.setAttribute('role', 'button'); el.tabIndex = 0;
}
function renderHomework() {
  const tk = todayKey(); const occ = occurrences(addDays(tk, -14), addDays(tk, 21)).filter(o => o.ev.cat === 'homework');
  const todo = occ.filter(o => !isDone(o.ev, o.key) && (o.key >= addDays(tk, -14))); const done = occ.filter(o => isDone(o.ev, o.key) && o.key >= addDays(tk, -3));
  const el = $('#hwCard');
  const meta = k => { const d = diffDays(tk, k); return d < 0 ? `<span class="hw-meta late">OVERDUE ${-d}d</span>` : d === 0 ? '<span class="hw-meta soon">DUE TODAY</span>' : d === 1 ? '<span class="hw-meta soon">DUE TMRW</span>' : ''; };
  el.innerHTML = `<div class="ph"><div><h2>📚 Homework & due dates</h2><div class="sub">${todo.length ? todo.length + ' to do' : 'All caught up 🙌'}</div></div><button type="button" class="add-mini" data-addhw="1">+ Homework</button></div>` +
    todo.slice(0, 12).map(o => evRow(o, { withDay: true }).replace('<span class="tx">', '<span class="tx">' + meta(o.key))).join('') +
    (done.length ? `<div class="hw-done-t">Done recently</div>` + done.slice(-5).map(o => evRow(o, { withDay: true })).join('') : '');
}
function render(dir) { renderView(dir); renderNextUp(); renderHomework(); }

/* ---------- navigation ---------- */
function shift(dir) {
  if (UI.view === 'month') { const d = dOf(UI.cursor); const n = new Date(d.getFullYear(), d.getMonth() + dir, 1); UI.cursor = keyOf(n); const s = dOf(UI.sel); if (s.getMonth() !== n.getMonth() || s.getFullYear() !== n.getFullYear()) UI.sel = keyOf(n); }
  else if (UI.view === 'week') UI.cursor = addDays(UI.cursor, 7 * dir);
  else if (UI.view === 'day') { UI.cursor = addDays(UI.cursor, dir); UI.sel = UI.cursor; }
  renderView(dir);
}
function goToday() { UI.cursor = UI.sel = todayKey(); render(); }
function setView(v) { UI.view = v; if (v === 'day') UI.cursor = UI.sel; if (v === 'month' || v === 'week') UI.cursor = UI.sel; DB.settings.view = v; try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch {} renderView(); }

/* ---------- toast + sheet ---------- */
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }
let lastFocus = null;
function openSheet(html, onMount) {
  lastFocus = document.activeElement; const w = $('#sheetWrap'); $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  w.classList.remove('hidden'); w.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden';
  if (onMount) onMount($('#sheet'));
}
function closeSheet() { const w = $('#sheetWrap'); w.classList.add('hidden'); w.setAttribute('aria-hidden', 'true'); $('#sheet').innerHTML = ''; document.body.style.overflow = ''; if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch {} }

/* ---------- editor ---------- */
const REM_OPTS = [[0, 'At start'], [10, '10 min'], [30, '30 min'], [60, '1 hr'], [120, '2 hr'], [1440, '1 day'], [10080, '1 week']];
function openEditor(ev, occKey) {
  const isNew = !ev || !DB.events.some(x => x.id === ev.id);
  const e = cleanEvent(ev || { date: UI.sel || todayKey(), allDay: true, cat: 'other' });
  if (isNew && !ev) { e.title = ''; }
  const remOn = !!(window.NXRem && window.NXRem.available());
  openSheet(`<div class="sh-head"><h2 id="sheetTitle">${isNew ? 'New event' : 'Edit event'}</h2><button type="button" class="x" data-close aria-label="Close">✕</button></div>
  <form id="evForm" novalidate>
    <div class="field"><label for="fTitle">Title</label><input id="fTitle" class="inp" maxlength="120" placeholder="Math test" value="${esc(e.title)}" required></div>
    <div class="field"><span class="flabel">Category</span><div class="cats" id="fCats">${Object.entries(CATS).map(([k, c]) => `<button type="button" class="cat" style="--c:${c.c}" data-cat="${k}" aria-pressed="${k === e.cat}">${c.e} ${c.n}</button>`).join('')}</div></div>
    <div class="field"><label for="fDate">${e.cat === 'homework' ? 'Due date' : 'Date'}</label><input id="fDate" type="date" class="inp" value="${e.date}" required></div>
    <div class="switch"><span class="lbl">All day</span><button type="button" class="tog" id="fAllDay" role="switch" aria-checked="${e.allDay}" aria-label="All day"></button></div>
    <div class="row2 field" id="fTimes"${e.allDay ? ' hidden' : ''}><div><label for="fStart">Starts</label><input id="fStart" type="time" class="inp" value="${e.start || '15:00'}"></div><div><label for="fEnd">Ends</label><input id="fEnd" type="time" class="inp" value="${e.end || '16:00'}"></div></div>
    <div class="field"><label for="fRepeat">Repeat</label><select id="fRepeat" class="inp">${Object.entries(REPEAT).map(([k, n]) => `<option value="${k}"${k === e.repeat ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
    ${remOn ? `<div class="field"><span class="flabel">Remind me (push notification)</span><div class="cats" id="fRem">${REM_OPTS.map(([m, n]) => `<button type="button" class="cat" style="--c:#3b82f6" data-rem="${m}" aria-pressed="${e.rem.includes(m)}">${n}</button>`).join('')}</div><div class="sub" id="fRemNote" style="font-size:.75rem;color:var(--dim);margin-top:.35rem"></div></div>` : ''}
    <div class="field"><label for="fNotes">Notes</label><textarea id="fNotes" class="inp" maxlength="2000" placeholder="Room 204, bring calculator...">${esc(e.notes)}</textarea></div>
    <div class="err" id="fErr"></div>
    <div class="btns">${isNew ? '' : '<button type="button" class="btn danger" id="fDel">Delete</button>'}<button type="submit" class="btn primary">${isNew ? 'Add event' : 'Save'}</button></div>
  </form>`, sh => {
    let cat = e.cat; const rem = new Set(e.rem);
    sh.querySelector('#fCats').addEventListener('click', ev2 => { const b = ev2.target.closest('[data-cat]'); if (!b) return; cat = b.dataset.cat; sh.querySelectorAll('[data-cat]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); sh.querySelector('label[for=fDate]').textContent = cat === 'homework' ? 'Due date' : 'Date'; });
    const ad = sh.querySelector('#fAllDay'); ad.onclick = () => { const v = ad.getAttribute('aria-checked') !== 'true'; ad.setAttribute('aria-checked', String(v)); sh.querySelector('#fTimes').hidden = v; if (sh.querySelector('#fRem')) sh.querySelector('#fRem').dispatchEvent(new CustomEvent('note')); };
    const st = sh.querySelector('#fStart'), en = sh.querySelector('#fEnd'); let lastS = toMin(st.value);
    st.addEventListener('change', () => { const s = toMin(st.value), d = (toMin(en.value) ?? s + 60) - (lastS ?? s); if (s != null) { en.value = fromMin(Math.min(s + Math.max(d, 15), 1439)); lastS = s; } });
    const remBox = sh.querySelector('#fRem');
    if (remBox) {
      const note = () => { const n = sh.querySelector('#fRemNote'); const ad2 = sh.querySelector('#fAllDay').getAttribute('aria-checked') === 'true'; n.textContent = rem.size ? (window.NXRem.enabled() ? 'Reminders are on for this phone.' : 'Saving turns on notifications for this phone (Chrome will ask).') + (ad2 ? ' All-day events count from 8 AM.' : '') : ''; };
      remBox.addEventListener('note', () => note()); remBox.addEventListener('click', ev2 => { const b = ev2.target.closest('[data-rem]'); if (!b) return; const m = +b.dataset.rem; rem.has(m) ? rem.delete(m) : rem.add(m); b.setAttribute('aria-pressed', String(rem.has(m))); note(); }); note();
    }
    if (isNew && !ev) setTimeout(() => sh.querySelector('#fTitle').focus(), 50);
    sh.querySelector('#evForm').onsubmit = async ev2 => {
      ev2.preventDefault();
      const title = sh.querySelector('#fTitle').value.trim(); const date = sh.querySelector('#fDate').value; const allDay = ad.getAttribute('aria-checked') === 'true';
      const err = m => { sh.querySelector('#fErr').textContent = m; };
      if (!title) return err('Give it a title.'); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('Pick a date.');
      if (!allDay) { if (!st.value) return err('Pick a start time.'); if (en.value && toMin(en.value) <= toMin(st.value)) return err('End time has to be after the start.'); }
      const out = cleanEvent({ ...e, title, cat, date, allDay, start: allDay ? null : st.value, end: allDay ? null : (en.value || null), repeat: sh.querySelector('#fRepeat').value, notes: sh.querySelector('#fNotes').value, rem: [...rem].sort((a, b) => a - b), updated: Date.now() });
      if (isNew) DB.events.push(out); else DB.events = DB.events.map(x => x.id === out.id ? out : x);
      save(); UI.sel = out.date; if (UI.view !== 'agenda') UI.cursor = out.date; closeSheet(); render();
      toast(isNew ? `${CATS[out.cat].e} Added: ${out.title}` : 'Saved');
      if (out.rem.length && window.NXRem) window.NXRem.ensure().catch(er => toast(er.message || 'Reminders could not turn on'));
    };
    const del = sh.querySelector('#fDel');
    if (del) del.onclick = () => askDelete(e, occKey);
  });
}
function askDelete(e, occKey) {
  if (e.repeat === 'none' || !occKey) {
    if (!confirm(`Delete "${e.title}"?`)) return;
    return doDelete(e, 'all');
  }
  openSheet(`<div class="sh-head"><h2 id="sheetTitle">Delete repeating event</h2><button type="button" class="x" data-close aria-label="Close">✕</button></div>
    <p style="color:var(--muted);margin:.2rem 0 0">"${esc(e.title)}" repeats ${REPEAT[e.repeat].toLowerCase()}.</p>
    <div class="choice"><button type="button" class="btn" id="dOne">Just ${esc(relDay(occKey))}</button><button type="button" class="btn danger" id="dAll">Every one</button></div>`, sh => {
    sh.querySelector('#dOne').onclick = () => doDelete(e, 'one', occKey);
    sh.querySelector('#dAll').onclick = () => doDelete(e, 'all');
  });
}
function doDelete(e, mode, occKey) {
  if (mode === 'one') DB.events = DB.events.map(x => x.id === e.id ? { ...x, ex: [...(x.ex || []), occKey], updated: Date.now() } : x);
  else { DB.events = DB.events.filter(x => x.id !== e.id); for (const k of Object.keys(DB.done)) if (k.startsWith(e.id + '@')) delete DB.done[k]; }
  save(); closeSheet(); render(); toast('Deleted');
}

/* ---------- search ---------- */
function openSearch() {
  openSheet(`<div class="sh-head"><h2 id="sheetTitle">Search</h2><button type="button" class="x" data-close aria-label="Close">✕</button></div>
    <input id="sInput" type="search" class="inp" placeholder="Search titles, notes, categories..." enterkeyhint="search" autocomplete="off"><div id="sRes" class="sr-res"></div>`, sh => {
    const inp = sh.querySelector('#sInput'), res = sh.querySelector('#sRes'); const tk = todayKey();
    const run = () => {
      const q = inp.value.trim().toLowerCase();
      if (!q) { res.innerHTML = `<div class="empty">${DB.events.length} event${DB.events.length === 1 ? '' : 's'} saved</div>`; return; }
      const hits = DB.events.filter(e => (e.title + ' ' + e.notes + ' ' + CATS[e.cat].n).toLowerCase().includes(q));
      const rows = hits.map(ev => { const nx = occurrences(tk, addDays(tk, 400)).find(o => o.ev.id === ev.id); return { ev, key: nx ? nx.key : ev.date }; }).sort((a, b) => (a.key < tk) - (b.key < tk) || (a.key < b.key ? -1 : 1));
      res.innerHTML = rows.length ? rows.slice(0, 50).map(o => evRow(o, { withDay: true })).join('') : '<div class="empty">No matches</div>';
    };
    inp.addEventListener('input', run); run(); setTimeout(() => inp.focus(), 50);
  });
}

/* ---------- settings / backup ---------- */
function openSettings() {
  const remHtml = window.NXRem ? window.NXRem.settingsHtml() : '';
  openSheet(`<div class="sh-head"><h2 id="sheetTitle">Settings</h2><button type="button" class="x" data-close aria-label="Close">✕</button></div>
    <div class="set-group">
      <div class="switch"><span class="lbl">US holidays<small>Thanksgiving, Christmas, Easter, etc.</small></span><button type="button" class="tog" id="sHol" role="switch" aria-checked="${DB.settings.holidays}" aria-label="Show US holidays"></button></div>
      <div class="switch"><span class="lbl">Week starts Monday</span><button type="button" class="tog" id="sMon" role="switch" aria-checked="${DB.settings.weekStart === 1}" aria-label="Week starts Monday"></button></div>
    </div>
    ${remHtml}
    <div class="set-group">
      <button type="button" class="set-row" id="sExport"><span>⬇️ Export backup<small>Saves a .json file with all ${DB.events.length} events</small></span><span>›</span></button>
      <button type="button" class="set-row" id="sImport"><span>⬆️ Import backup<small>Adds events from a NEXUS Calendar .json file</small></span><span>›</span></button>
    </div>
    <div class="set-group"><button type="button" class="set-row red" id="sWipe"><span>🗑️ Delete all events</span><span>›</span></button></div>
    <p class="foot">Your events stay on this phone. Nothing is uploaded${window.NXRem && window.NXRem.enabled() ? ', except reminders, which are sent locked so only your reminder service can read them' : ''}.</p>`, sh => {
    const tog = (id, fn) => { const b = sh.querySelector(id); b.onclick = () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); fn(v); save(); render(); }; };
    tog('#sHol', v => { DB.settings.holidays = v; }); tog('#sMon', v => { DB.settings.weekStart = v ? 1 : 0; });
    sh.querySelector('#sExport').onclick = exportJSON;
    sh.querySelector('#sImport').onclick = () => $('#importFile').click();
    sh.querySelector('#sWipe').onclick = () => { if (!DB.events.length) return toast('Nothing to delete'); if (confirm(`Delete all ${DB.events.length} events? Export a backup first if you might want them.`)) { DB.events = []; DB.done = {}; save(); render(); closeSheet(); toast('All events deleted'); } };
    if (window.NXRem) window.NXRem.mountSettings(sh);
  });
}
function exportJSON() {
  const data = { app: 'NEXUS Calendar', version: 1, exported: new Date().toISOString(), events: DB.events, done: DB.done, settings: DB.settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `nexus-calendar-backup-${todayKey()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Backup saved to Downloads');
}
function importJSON(text) {
  let data; try { data = JSON.parse(text); } catch { return toast("That file isn't a backup (bad JSON)"); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.events) ? data.events : null;
  if (!list) return toast("That file isn't a NEXUS Calendar backup");
  const byId = new Map(DB.events.map(e => [e.id, e])); let added = 0, updated = 0;
  for (const raw of list) { if (!raw || typeof raw !== 'object') continue; const e = cleanEvent(raw); if (byId.has(e.id)) updated++; else added++; byId.set(e.id, e); }
  DB.events = [...byId.values()]; if (data.done && typeof data.done === 'object') Object.assign(DB.done, data.done);
  save(); render(); closeSheet(); toast(`Imported: ${added} new, ${updated} updated`);
}

/* ---------- quick add ---------- */
function bindQuick() {
  const inp = $('#quickInput'), pv = $('#quickPreview');
  inp.addEventListener('input', () => {
    const e = parseQuick(inp.value); if (!e || inp.value.trim().length < 2) { pv.classList.add('hidden'); return; }
    const c = CATS[e.cat]; pv.classList.remove('hidden');
    pv.innerHTML = `<span class="pv">${c.e} ${esc(e.title)}</span><span class="pv">${esc(relDay(e.date) === fmtDate(e.date) ? fmtDate(e.date) : relDay(e.date) + ', ' + fmtDate(e.date))}</span><span class="pv">${e.allDay ? 'All day' : fmtT(e.start) + '–' + fmtT(e.end)}</span>${e.repeat !== 'none' ? `<span class="pv">🔁 ${REPEAT[e.repeat]}</span>` : ''}<span class="pv" style="color:${c.c}">${c.n}</span>`;
  });
  $('#quickForm').addEventListener('submit', ev => {
    ev.preventDefault(); const e = parseQuick(inp.value); if (!e) { openEditor(); return; }
    DB.events.push(e); save(); inp.value = ''; pv.classList.add('hidden'); inp.blur();
    UI.sel = e.date; if (UI.view !== 'agenda') UI.cursor = e.date; render();
    toast(`${CATS[e.cat].e} Added: ${e.title}, ${relDay(e.date)}${e.allDay ? '' : ' ' + fmtT(e.start)}`);
  });
}

/* ---------- events ---------- */
function bind() {
  document.addEventListener('click', e => {
    const t = e.target;
    const close = t.closest('[data-close]'); if (close) { closeSheet(); return; }
    const dn = t.closest('[data-done]');
    if (dn) { e.stopPropagation(); const k = dn.dataset.done + '@' + dn.dataset.key; if (DB.done[k]) delete DB.done[k]; else { DB.done[k] = Date.now(); toast('✅ Nice, done!'); } save(); render(); if (!$('#sheetWrap').classList.contains('hidden') && $('#sRes')) $('#sInput').dispatchEvent(new Event('input')); return; }
    const op = t.closest('[data-open]');
    if (op) { const ev = DB.events.find(x => x.id === op.dataset.open); if (ev) openEditor(ev, op.dataset.key); return; }
    const day = t.closest('[data-day]');
    if (day) { const k = day.dataset.day; const out = dOf(k).getMonth() !== dOf(UI.cursor).getMonth(); UI.sel = k; if (out) { UI.cursor = k; renderView(k > UI.cursor ? 1 : -1); } else renderView(); return; }
    const gd = t.closest('[data-goday]'); if (gd) { UI.sel = UI.cursor = gd.dataset.goday; setView('day'); return; }
    const ao = t.closest('[data-addon]'); if (ao) { openEditor({ date: ao.dataset.addon, allDay: true, cat: 'other', title: '' }); return; }
    if (t.closest('[data-addhw]')) { openEditor({ date: addDays(todayKey(), 1), allDay: true, cat: 'homework', title: '' }); return; }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#sheetWrap').classList.contains('hidden')) closeSheet();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open][role=button]')) { e.preventDefault(); e.target.click(); }
  });
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('#prevBtn').onclick = () => shift(-1); $('#nextBtn').onclick = () => shift(1); $('#todayBtn').onclick = goToday;
  $('#fab').onclick = () => openEditor(); $('#searchBtn').onclick = openSearch; $('#settingsBtn').onclick = openSettings;
  $('#importFile').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importJSON(await f.text()); });
  // swipe between months / weeks / days
  const v = $('#view'); let sx = 0, sy = 0, st = 0, tracking = false;
  v.addEventListener('touchstart', e => { if (e.touches.length !== 1 || UI.view === 'agenda') return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); tracking = true; }, { passive: true });
  v.addEventListener('touchend', e => {
    if (!tracking) return; tracking = false; const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && Date.now() - st < 800) shift(dx < 0 ? 1 : -1);
  }, { passive: true });
  // re-render when the day changes (app left open overnight) and every minute for "next up"
  let lastDay = todayKey();
  setInterval(() => { if (todayKey() !== lastDay) { lastDay = todayKey(); goToday(); } else renderNextUp(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (todayKey() !== lastDay) { lastDay = todayKey(); goToday(); } else render(); } });
  window.addEventListener('storage', e => { if (e.key === KEY) { DB = load(); render(); } });
}
function handleHash() {
  const h = location.hash;
  if (h === '#add') { history.replaceState(null, '', location.pathname + location.search); openEditor(); }
  else if (h === '#today') { history.replaceState(null, '', location.pathname + location.search); goToday(); }
  else if (h.startsWith('#ev=')) { const [id, k] = decodeURIComponent(h.slice(4)).split('@'); history.replaceState(null, '', location.pathname + location.search); const ev = DB.events.find(x => x.id === id); if (ev) { UI.sel = UI.cursor = k || ev.date; render(); openEditor(ev, k); } }
}

/* ---------- PWA: service worker + install ---------- */
let deferredPrompt = null;
function initPWA() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW failed', err));
  const btn = $('#installBtn'); const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (!standalone) btn.classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { btn.classList.add('hidden'); deferredPrompt = null; toast('Installed! NEXUS Calendar is on your home screen'); });
  btn.onclick = async () => {
    if (!deferredPrompt) { toast('Use the Chrome menu ⋮ → Install app'); return; }
    deferredPrompt.prompt(); const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
    deferredPrompt = null; if (outcome === 'accepted') btn.classList.add('hidden');
  };
  const bar = $('#offlineBar'); const upd = () => bar.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
}

/* ---------- boot ---------- */
window.NXCal = { get DB() { return DB; }, CATS, occurrences, parseQuick, keyOf, addDays, toMin, todayKey, toast, render, save, openSettings };
bind(); bindQuick(); initPWA(); render(); handleHash();
window.addEventListener('hashchange', handleHash);
})();
