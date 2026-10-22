// Booking engine shared by bus.mjs (terminal) and gui.mjs (browser UI).
// No dependencies, Node 18+.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { AccessError, assertAllowedLogin, checkAccessConfiguration } from './access.mjs';
export { AccessError, checkAccessConfiguration } from './access.mjs';

export const ORIGIN = process.env.BUS_ORIGIN ?? 'https://bus-med.1337.ma';
const API = `${ORIGIN}/api`;
const MAX_INFLIGHT = 4;    // parallel requests during the rush
const BURST_GAP = 5;       // ms between requests right around the opening...
const BURST_BEFORE = 20;   // ...starting this long (+ one-way latency) before it
const BURST_AFTER = 300;   // ...until this long after it
const BURST_INFLIGHT = 8;
const PREP_LEAD = 75_000;  // re-check login + sync clock this long before opening
export const DEFAULTS = { early: null, interval: 40, duration: 15, dryRun: false };

export class BusError extends Error {}

let cookieFile = null;
let COOKIE = '';
let verifiedSession = null;
const IDENTITY_MAX_AGE = 60_000;
let clockOffset = 0; // server clock minus local clock, ms
let oneWay = 50;     // estimated one-way latency, ms
export const serverNow = () => Date.now() + clockOffset;
export const clockInfo = () => ({ offset: Math.round(clockOffset), ping: Math.round(oneWay * 2) });

// ---------- session ----------

export function useCookieFile(path) { cookieFile = path; }

export function reloadCookie() {
  let raw = process.env.BUS_COOKIE;
  if (!raw) {
    if (!cookieFile || !existsSync(cookieFile)) throw new BusError(`No cookie yet - put it in ${cookieFile}.`);
    raw = readFileSync(cookieFile, 'utf8');
  }
  setCookie(parseCookie(raw));
}

// Stores only the cookies for this site, never the rest of a JSON export.
export async function saveCookie(raw) {
  const cookie = parseCookie(raw);
  const r = await authenticate(cookie);
  requireAuthenticated(r);
  writeFileSync(cookieFile, `${cookie}\n`, { mode: 0o600 });
  setCookie(cookie);
  verifiedSession = { cookie, user: r.data, at: Date.now() };
}

function setCookie(cookie) {
  if (COOKIE !== cookie) verifiedSession = null;
  COOKIE = cookie;
}

function parseCookie(raw) {
  raw = String(raw ?? '').trim();
  // JSON export from a cookie extension: keep only cookies for this site
  if (raw.startsWith('[') || raw.startsWith('{')) {
    let list;
    try { list = JSON.parse(raw); } catch { throw new BusError('That looks like JSON but does not parse.'); }
    list = Array.isArray(list) ? list : list.cookies ?? [];
    const host = new URL(ORIGIN).hostname;
    const mine = list.filter(c => {
      const d = String(c?.domain ?? '').replace(/^\./, '');
      return c?.name && d && (host === d || host.endsWith(`.${d}`));
    });
    if (!mine.length) {
      const seen = [...new Set(list.map(c => c?.domain))].join(', ');
      throw new BusError(`No cookies for ${host} in there (it has: ${seen}). Export them from a ${host} tab.`);
    }
    return mine.map(c => `${c.name}=${c.value}`).join('; ');
  }
  const c = raw.replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, '').trim();
  if (!c) throw new BusError('Cookie is empty.');
  if (c.length > 6000) throw new BusError(`Cookie is ${c.length} chars - that's not just the bus site's cookie.`);
  return c;
}

export async function checkCookie(cookie) {
  try { return (await authenticate(cookie)).ok; }
  catch (e) { if (e instanceof AccessError) throw e; return false; }
}

// earliest "exp" of any JWT in the cookie, or Infinity
export function sessionExpiry() {
  let exp = Infinity;
  for (const part of COOKIE.split(';')) {
    const seg = part.slice(part.indexOf('=') + 1).trim().split('.');
    if (seg.length !== 3) continue;
    try {
      const p = JSON.parse(Buffer.from(seg[1], 'base64url').toString());
      if (p.exp) exp = Math.min(exp, p.exp * 1000);
    } catch {}
  }
  return exp;
}

export async function whoami() {
  const r = await api('GET', '/auth/isAuth');
  requireAuthenticated(r);
  return r.data;
}

function requireAuthenticated(r) {
  if (r.status === 401) throw new BusError('Not logged in: the cookie is missing or expired.');
  if (!r.ok) throw new BusError(`Login check failed: ${r.status} ${msgOf(r)}`);
}

export const latestTicket = () => api('GET', '/tickets/latest').then(r => (r.ok ? r.data : null), e => {
  if (e instanceof AccessError) throw e;
  return null;
});

// ---------- data ----------

// Upcoming routes merged with currently listed departures, soonest first.
export async function loadItems() {
  const [up, cur] = await Promise.all([api('GET', '/departure/upcoming'), api('GET', '/departure/current')]);
  if (!up.ok) throw new BusError(`Could not load upcoming departures: ${up.status} ${msgOf(up)}`);
  const byRoute = new Map();
  for (const route of asArray(up.data)) byRoute.set(route.id, { route, dep: null });
  for (const dep of openDeps(cur)) {
    const id = dep.route?.id ?? dep.route_id;
    const item = byRoute.get(id) ?? { route: dep.route ?? { id, name: `departure ${dep.id}` }, dep: null };
    item.dep = dep;
    byRoute.set(id, item);
  }
  // soonest first; same opening time: BUS 01, BUS 02, BUS 03...
  const busName = it => String(it.route.bus?.name ?? '');
  return [...byRoute.values()].sort((a, b) =>
    (opensKey(a) - opensKey(b)) ||
    busName(a).localeCompare(busName(b), undefined, { numeric: true }) ||
    String(a.route.name).localeCompare(String(b.route.name)));
}

// same count as the site's seat map: cancelled tickets don't take a seat
export const takenSeats = dep => dep?.tickets?.filter(t => !t.status || /^booked$/i.test(t.status)).length ?? null;

export const opensKey =it => isOpen(it.route, it.dep) ? 0 : it.route.available_time ? nextOpening(it.route) : Infinity;

async function findDeparture(route) {
  const r = await api('GET', '/departure/current');
  return openDeps(r).find(d => (d.route?.id ?? d.route_id) === route.id) ?? null;
}

// departures that are listed and haven't left yet
const openDeps = r => r?.ok ? asArray(r.data).filter(d => !d.departure_time || Date.parse(d.departure_time) > serverNow()) : [];
const asArray = x => Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : [];

// A listed departure counts as bookable unless its route opens within 30 min
// (then it was listed early and we still wait for the opening time).
export const isOpen = (route, dep) => !!dep && !(route.available_time && nextOpening(route) - serverNow() < 30 * 60e3);

// available_time is "HH:MM[:SS]" in UTC, same as the site's countdown
export function nextOpening(route) {
  const [h, m, s] = String(route.available_time).split(':').map(Number);
  const now = serverNow();
  const t = new Date(now);
  t.setUTCHours(h, m, s || 0, 0);
  if (t.getTime() <= now) t.setUTCDate(t.getUTCDate() + 1);
  return t.getTime();
}

export const label = r => `${r.bus?.name ?? 'bus'} -> ${r.name ?? '?'}${r.departure_time ? ` @ ${hhmm(r.departure_time)}` : ''}`;

// ---------- booking ----------

// Try routes in priority order; the next one only if the previous failed.
// opts: early, interval, duration, dryRun, signal, log(text), tick(opensAt),
//       onPhase(phase, opensAt, route), relogin(deadline) -> renews the cookie
export async function runPlan(routes, opts) {
  const o = { ...DEFAULTS, log: () => {}, ...opts };
  let r;
  for (const route of routes) {
    r = await grab(route, o);
    if (r.ok || r.already) return r;
    o.log(`[${label(route)}] failed: ${r.reason}`);
    if (r.fatal) return r;
  }
  return r;
}

async function grab(route, o) {
  const name = label(route);
  const { signal, log } = o;
  const tick = o.tick ?? (() => {});
  const phase = (p, t) => o.onPhase?.(p, t, route);
  let dep = await findDeparture(route);
  if (isOpen(route, dep)) {
    log(`[${name}] booking is open - firing now`);
    phase('firing', serverNow());
    return rush(route, dep, serverNow(), o);
  }
  if (!route.available_time) return { ok: false, reason: 'not open and has no opening time' };

  const opensAt = nextOpening(route);
  phase('waiting', opensAt);
  log(`[${name}] booking opens at ${clock(opensAt)}`);
  if (sessionExpiry() < opensAt) log(`WARNING: your login expires at ${clock(sessionExpiry())}, before booking opens - refresh the cookie before then.`);
  await waitUntil(opensAt - PREP_LEAD, signal, () => tick(opensAt));

  // ~75s before: reload cookie, check login (renew it if needed), measure clock offset + ping precisely
  phase('preparing', opensAt);
  try { reloadCookie(); } catch {}
  let me = await api('GET', '/auth/isAuth');
  if ((me.status === 401 || sessionExpiry() < opensAt + o.duration * 1000) && o.relogin) {
    log('login expired or about to - renewing it');
    try {
      await o.relogin(opensAt - 10_000);
      me = await api('GET', '/auth/isAuth');
      if (me.ok) log('login renewed');
    } catch (e) {
      if (e instanceof AccessError) throw e;
      log(`could not renew login: ${e.message}`);
    }
  }
  if (me.status === 401) return { ok: false, fatal: true, reason: 'not logged in - log in again and start again' };
  log(await syncClock(30));

  const early = o.early ?? Math.round(oneWay + 120);
  const sendAt = opensAt - early;
  // the departure might be listed before booking opens; look for it while waiting
  while (sendAt - serverNow() > 2500) {
    dep ??= await findDeparture(route).catch(() => null);
    await waitUntil(Math.min(serverNow() + 2000, sendAt - 2500), signal, () => tick(opensAt));
  }
  // open a few keep-alive connections so the rush skips TCP/TLS handshakes
  await sleepUntil(sendAt - 1500, signal);
  await Promise.all(Array.from({ length: BURST_INFLIGHT }, () => api('GET', '/auth/isAuth').catch(() => null)));
  await sleepUntil(sendAt, signal);
  phase('firing', opensAt);
  log(`firing (${early}ms early, every ${o.interval}ms, every ${BURST_GAP}ms around the opening)${dep ? ` at departure #${dep.id}` : ''}`);
  return rush(route, dep, opensAt, o);
}

// Fire booking requests (or, until the departure shows up, lookups) until one
// sticks. The site creates the departure 30-75ms after the hour, so right
// around the opening they go out every BURST_GAP ms from a tight loop (Windows
// timers are ~15ms coarse); before and after that burst, every o.interval ms.
function rush(route, knownDep, opensAt, o) {
  return new Promise(resolve => {
    let dep = knownDep, inflight = 0, shots = 0, lastMsg = '', finished = false, next = 0;
    let booking = false; // one booking request at a time: never risk two seats
    const deadline = Math.max(opensAt, serverNow()) + o.duration * 1000;
    const burstFrom = opensAt - oneWay - BURST_BEFORE, burstTo = opensAt + BURST_AFTER;
    const finish = r => {
      if (finished) return;
      finished = true;
      resolve({ ...r, shots });
    };
    const say = (ms, m) => { if (m !== lastMsg) { lastMsg = m; o.log(`${rel(ms)}  ${m}`); } };
    const onErr = e => e instanceof AccessError || e instanceof BusError
      ? finish({ ok: false, fatal: true, reason: e.message })
      : say(serverNow() - opensAt, `network: ${e.cause?.code ?? e.name ?? e.message}`);

    const book = async () => {
      if (o.dryRun) return finish({ ok: true, dry: true, dep, at: serverNow() - opensAt });
      if (booking) return;
      booking = true;
      shots++;
      let r;
      try {
        r = await api('POST', '/tickets/book', { departure_id: dep.id, to_campus: false });
      } finally {
        booking = false;
      }
      if (finished) return;
      const at = r.t1 + clockOffset - opensAt;
      if (r.ok) return finish({ ok: true, at, dep });
      const m = msgOf(r);
      say(at, `${r.status} ${m}`);
      if (r.status === 401) finish({ ok: false, fatal: true, reason: 'session expired - refresh the cookie' });
      else if (/already|d[eé]j[aà]/i.test(m)) finish({ ok: false, already: true, msg: m });
      else if (/full|no (more )?(seats?|places?)|complet|capacity/i.test(m)) finish({ ok: false, reason: m });
    };
    const look = async () => {
      const found = await findDeparture(route);
      if (finished || dep || !found) return;
      dep = found;
      say(serverNow() - opensAt, `departure #${dep.id} appeared`);
      inflight++;
      book().catch(onErr).finally(() => inflight--);
    };
    const loop = () => {
      if (finished) return;
      const now = serverNow();
      if (o.signal?.aborted) return finish({ ok: false, fatal: true, stopped: true, reason: 'stopped' });
      if (now > deadline) return finish({ ok: false, reason: `no luck after ${o.duration}s (last answer: ${lastMsg || 'none'})` });
      const burst = now >= burstFrom && now <= burstTo;
      if (burst && next > now + BURST_GAP) next = now; // don't carry the slow pace into the burst
      if (now >= next && !(dep && booking) && inflight < (burst ? BURST_INFLIGHT : MAX_INFLIGHT)) {
        next = now + (burst ? BURST_GAP : o.interval);
        inflight++;
        (dep ? book() : look()).catch(onErr).finally(() => inflight--);
      }
      // spin through the burst (responses still get handled between turns),
      // otherwise sleep until the next request or the burst, whichever is first
      const t = serverNow();
      if (t >= burstFrom - 20 && t <= burstTo) return setImmediate(loop);
      const untilBurst = t < burstFrom - 20 ? burstFrom - 20 - t : Infinity;
      setTimeout(loop, Math.max(5, Math.min(next - t, untilBurst)));
    };
    loop();
  });
}

export function describeResult(r) {
  if (!r) return 'Nothing to do.';
  if (r.dry) return `DRY RUN: departure #${r.dep?.id} was bookable at ${rel(r.at)} - a real run would have booked here.`;
  if (r.ok) return `BOOKED at ${rel(r.at)} after opening (${r.shots} request${r.shots === 1 ? '' : 's'})`;
  if (r.already) return `Server says: ${r.msg}`;
  return `Failed: ${r.reason}`;
}

// ---------- http / clock ----------

async function api(method, path, body) {
  // Capture the cookie so a concurrent GUI login cannot change the account
  // between checking its identity and sending this request.
  const cookie = COOKIE;
  if (method === 'GET' && path === '/auth/isAuth') return authenticate(cookie);
  const session = verifiedSession;
  if (!session || session.cookie !== cookie || Date.now() - session.at >= IDENTITY_MAX_AGE) {
    requireAuthenticated(await authenticate(cookie));
  } else {
    assertAllowedLogin(session.user);
  }
  return request(method, path, body, cookie);
}

async function authenticate(cookie) {
  checkAccessConfiguration();
  // Identity comes from the authenticated bus endpoint, never a decoded JWT
  // or a login name supplied by the GUI. Redirects must not count as a login.
  const r = await request('GET', '/auth/isAuth', undefined, cookie);
  if (COOKIE === cookie) verifiedSession = null;
  if (r.ok) {
    assertAllowedLogin(r.data);
    if (COOKIE === cookie) verifiedSession = { cookie, user: r.data, at: Date.now() };
  }
  return r;
}

async function request(method, path, body, cookie) {
  const t0 = Date.now();
  const res = await fetch(API + path, {
    method,
    redirect: 'error',
    headers: {
      cookie,
      origin: ORIGIN,
      referer: `${ORIGIN}/home`,
      accept: 'application/json, text/plain, */*',
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const t1 = Date.now();
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data, t0, t1, date: res.headers.get('date') };
}

function msgOf(r) {
  const m = r.data?.message ?? r.data;
  return (Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : JSON.stringify(m) ?? '').slice(0, 200);
}

// The server's Date header has 1s resolution; many samples at different
// sub-second phases narrow the offset down to tens of ms. We keep trusting the
// local clock unless the samples prove it wrong.
export async function syncClock(samples) {
  let lo = -Infinity, hi = Infinity;
  const rtts = [];
  for (let i = 0; i < samples; i++) {
    const r = await api('GET', '/auth/isAuth').catch(() => null);
    const d = r && Date.parse(r.date);
    if (d) {
      lo = Math.max(lo, d - r.t1);
      hi = Math.min(hi, d + 999 - r.t0);
      rtts.push(r.t1 - r.t0);
    }
    await sleep(20 + Math.random() * 100);
  }
  if (!rtts.length) return 'clock sync failed - using your PC clock';
  rtts.sort((a, b) => a - b);
  oneWay = rtts[rtts.length >> 1] / 2;
  clockOffset = lo <= hi ? Math.min(Math.max(0, lo), hi) : 0;
  const off = Math.round(clockOffset);
  const skew = off === 0 ? 'in sync with the server' : `${Math.abs(off)}ms ${off > 0 ? 'behind' : 'ahead of'} the server`;
  return `ping ~${Math.round(oneWay * 2)}ms, your clock is ${skew} (+-${Math.round((hi - lo) / 2)}ms)`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// setTimeout on Windows is ~15ms coarse, so spin for the last few ms
async function sleepUntil(t, signal) {
  for (;;) {
    const left = t - serverNow();
    if (left <= 0) return;
    if (left > 30) await sleep(left - 25, signal);
    else { while (serverNow() < t); return; }
  }
}

async function waitUntil(until, signal, tick) {
  while (serverNow() < until) {
    tick();
    await sleep(Math.min(1000, until - serverNow()), signal);
  }
}

// Stop the computer from going to sleep until the returned function is called
// (or this process exits). A closed laptop lid can still force sleep.
export function keepAwake() {
  const pid = String(process.pid);
  let cmd, args;
  if (process.platform === 'darwin') [cmd, args] = ['caffeinate', ['-i', '-w', pid]];
  else if (process.platform === 'win32') {
    const ps = `$k = Add-Type -Name A -Namespace KeepAwake -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void]$k::SetThreadExecutionState([uint32]2147483649)
Wait-Process -Id ${pid}`;
    [cmd, args] = ['powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')]];
  } else [cmd, args] = ['systemd-inhibit', ['--what=idle:sleep', '--who=bus', '--why=waiting to book a bus', 'tail', `--pid=${pid}`, '-f', '/dev/null']];
  const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // not available: just don't keep awake
  child.unref(); // must not keep this program running by itself
  const release = () => child.kill();
  process.once('exit', release);
  return release;
}

// ---------- formatting ----------

let hour12 = false;
export const useHour12 = on => { hour12 = !!on; };

function fmtTime(h, m, s) {
  const rest = `${String(m).padStart(2, '0')}${s == null ? '' : `:${String(s).padStart(2, '0')}`}`;
  return hour12 ? `${h % 12 || 12}:${rest} ${h < 12 ? 'AM' : 'PM'}` : `${String(h).padStart(2, '0')}:${rest}`;
}

export const clock = ms => { const d = new Date(ms); return fmtTime(d.getHours(), d.getMinutes(), d.getSeconds()); };

// "21:00:00" (as the site sends departure times) -> "21:00" or "9:00 PM"
function hhmm(str) {
  const [h, m] = String(str).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? fmtTime(h, m) : String(str).slice(0, 5);
}
export const rel = ms => `${ms >= 0 ? '+' : ''}${Math.round(ms)}ms`;

export function dur(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h ` : ''}${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}
