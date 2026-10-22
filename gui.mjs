#!/usr/bin/env node
// gui.mjs - point-and-click version of bus.mjs. Serves a local page on
// 127.0.0.1 and opens it in your browser; the booking itself runs here in
// Node so it stays precise even if the browser tab is in the background.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as bus from './core.mjs';
import { relogin, canLogin, findBrowser, openInBrowser } from './login.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = randomBytes(16).toString('hex');
const PORT = Number(process.env.BUS_GUI_PORT ?? 13370);

bus.useCookieFile(join(HERE, 'cookie.txt'));

let user = null, authError = null, latest = null, items = [];
let job = null;
let loginTask = null, loginText = null, autoLogin = true;
let ready = false; // first login check done

async function refresh() {
  try {
    bus.reloadCookie();
    user = await bus.whoami();
    authError = null;
    autoLogin = true; // next time it expires, log in again by itself
  } catch (e) {
    user = null;
    latest = null;
    items = [];
    if (e instanceof bus.AccessError) job?.controller.abort();
    authError = e instanceof bus.BusError || e instanceof bus.AccessError ? e.message : `Can't reach the bus site (${e.cause?.code ?? e.message})`;
    // logged out (no cookie or it expired): bring up the login once, not in a loop
    if (e instanceof bus.BusError && autoLogin && canLogin()) {
      autoLogin = false;
      startLogin().catch(() => {});
    }
    return;
  }
  [latest, items] = await Promise.all([bus.latestTicket(), bus.loadItems()]);
}

// One login at a time; a booking job that needs one joins the running one.
function startLogin({ deadline } = {}) {
  loginTask ??= (async () => {
    try {
      const cookie = await relogin({ deadline, log: m => (loginText = m) });
      await bus.saveCookie(cookie);
      loginText = null;
      await refresh();
    } catch (e) {
      loginText = `Login failed: ${e.message}`;
      throw e;
    } finally {
      loginTask = null;
    }
  })();
  return loginTask;
}

const view = it => {
  const r = it.route;
  const open = bus.isOpen(r, it.dep);
  return {
    id: r.id,
    bus: r.bus?.name ?? 'bus',
    name: r.name ?? '?',
    time: r.departure_time ? String(r.departure_time).slice(0, 5) : '',
    open,
    opensAt: open || !r.available_time ? null : bus.nextOpening(r),
    taken: bus.takenSeats(it.dep),
    capacity: r.bus?.capacity ?? null,
  };
};

const state = () => ({
  ready,
  user: user && { login: user.login },
  authError,
  expires: user && Number.isFinite(bus.sessionExpiry()) ? bus.sessionExpiry() : null,
  login: { busy: !!loginTask, text: loginText, browser: canLogin() ? findBrowser().name : null },
  latest: latest?.status ? { id: latest.id, status: latest.status } : null,
  items: items.map(view),
  serverNow: bus.serverNow(),
  tz: new Date().getTimezoneOffset(), // so the page shows the same times as the console
  clock: bus.clockInfo(),
  job: job && { ...job, controller: undefined },
});

function startJob(ids, dryRun) {
  const routes = ids.map(id => items.find(it => it.route.id === id)?.route).filter(Boolean);
  if (!routes.length) throw new bus.BusError('Pick at least one bus.');
  const controller = new AbortController();
  job = {
    id: Date.now(), dryRun, running: true, phase: 'starting', current: null, opensAt: null, log: [], result: null,
    targets: routes.map(r => ({ id: r.id, label: bus.label(r) })),
    controller,
  };
  const j = job;
  const log = text => {
    j.log.push({ t: bus.serverNow(), text });
    if (j.log.length > 400) j.log.shift();
  };
  const release = bus.keepAwake();
  (async () => {
    try {
      log(await bus.syncClock(12));
      const r = await bus.runPlan(routes, {
        dryRun,
        signal: controller.signal,
        log,
        onPhase: (phase, opensAt, route) => Object.assign(j, { phase, opensAt, current: route.id }),
        relogin: canLogin() ? deadline => startLogin({ deadline }) : undefined,
      });
      j.result = { ok: !!r?.ok, already: !!r?.already, dry: !!r?.dry, text: bus.describeResult(r) };
      j.phase = r?.stopped ? 'stopped' : r?.dry ? 'dry' : r?.ok ? 'booked' : r?.already ? 'already' : 'failed';
    } catch (e) {
      const stopped = controller.signal.aborted;
      j.result = { ok: false, text: stopped ? 'Stopped.' : `Error: ${e.message}` };
      j.phase = stopped ? 'stopped' : 'failed';
    } finally {
      release();
      log(j.result.text);
      j.running = false;
      refresh().catch(() => {});
    }
  })();
}

// ---------- http ----------

const HTML = readFileSync(join(HERE, 'gui.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  // only answer our own page: right Host (blocks DNS rebinding) and, for the
  // API, the secret token (blocks other websites poking at localhost)
  const port = server.address().port;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') return send(200, HTML, 'text/html; charset=utf-8');
  if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
  if (req.headers['x-token'] !== TOKEN) return send(403, { error: 'bad token - use the link printed in the console' });

  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/state':
        return send(200, state());
      case 'POST /api/refresh':
        await refresh();
        return send(200, state());
      case 'POST /api/login':
        if (!canLogin()) return send(400, { error: 'No login window available (needs Chrome, Edge, Brave or Firefox, and Node 22+). Paste the cookie instead.' });
        startLogin().catch(() => {});
        return send(200, state());
      case 'POST /api/cookie':
        await bus.saveCookie(body.cookie);
        await refresh();
        if (authError) return send(400, { error: authError });
        return send(200, state());
      case 'POST /api/start':
        if (job?.running) return send(409, { error: 'Already running - stop it first.' });
        await refresh();
        if (!user) return send(400, { error: authError ?? 'Not logged in.' });
        startJob(body.ids ?? [], !!body.dryRun);
        return send(200, state());
      case 'POST /api/stop':
        job?.controller.abort();
        return send(200, state());
      default:
        return send(404, { error: 'not found' });
    }
  } catch (e) {
    return send(e instanceof bus.AccessError ? 403 : e instanceof bus.BusError ? 400 : 500, { error: e.message });
  }
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new bus.BusError('Too big.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new bus.BusError('Bad JSON.')); }
    });
  });
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE' && server.listening === false && PORT !== 0) server.listen(0, '127.0.0.1');
  else throw e;
});
server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
  console.log(`Bus GUI running at ${url}`);
  console.log('Keep this window open - closing it stops the booking.');
  const b = findBrowser();
  console.log(`Browser: ${b ? `${b.name} (${b.open ? 'already open' : b.note ?? 'your default'})` : 'system default (login window unavailable)'}`);
  // page first, so a login window that pops up next has the page explaining it
  if (!process.env.BUS_GUI_NO_OPEN) openInBrowser(url);
  await bus.syncClock(8).catch(() => {});
  await refresh().catch(e => { authError = e.message; });
  ready = true;
});

// keep the list fresh while idle (opening times roll over, seats fill up)
setInterval(() => { if (!job?.running) refresh().catch(() => {}); }, 60_000);
