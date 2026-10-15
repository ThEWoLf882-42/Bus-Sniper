#!/usr/bin/env node
// bus.mjs - book a seat on bus-med.1337.ma the instant booking opens (terminal).
// Point-and-click version: gui.mjs. No dependencies, Node 18+.

import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import * as bus from './core.mjs';
import { relogin, canLogin } from './login.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `
bus.mjs - book a seat on bus-med.1337.ma the instant booking opens

  node bus.mjs                 pick a bus from a menu, wait, book it
  node bus.mjs --list          show buses and opening times, then exit
  node bus.mjs -r 7            book route id 7, no menu
  node bus.mjs -r tetouan,7    priority list: try "tetouan", if full try id 7
  node bus.mjs --login         log in with 42 in a browser window, then exit
  node gui.mjs                 same thing with a GUI in your browser

Options
  -r, --route <id|name>  route id or part of its name; comma list = fallbacks
  -l, --list             list and exit
      --login            open the 42 login window and save the session
      --12h              show times as 9:00 PM instead of 21:00
      --dry-run          do everything except send the booking request
      --early <ms>       start firing this many ms before opening (default: auto)
      --interval <ms>    gap between requests, except during the 5ms burst
                         from just before to 300ms after opening (default 40)
      --duration <s>     keep trying this long after opening (default 15)
      --cookie-file <p>  cookie file (default: cookie.txt next to this script)

Login: when you're not logged in (or the login expired) a Chrome/Edge/Brave/
Firefox window opens on the 42 login page; log in and it closes by itself.
Later renewals usually happen invisibly. Without a browser (or Node < 22):
export the cookies of a ${bus.ORIGIN}/home tab as JSON with a cookie
extension into cookie.txt. Only cookies for that site are used.
`;

const opt = parseArgs(process.argv.slice(2));
if (opt.help) { console.log(HELP); process.exit(0); }

const tty = process.stdout.isTTY;
const log = s => { if (tty) process.stdout.write('\r\x1b[K'); console.log(s); };

async function main() {
  bus.useCookieFile(resolve(opt.cookieFile ?? join(HERE, 'cookie.txt')));
  if (opt.login) await logIn();
  let me;
  try {
    bus.reloadCookie();
    me = await bus.whoami();
  } catch (e) {
    if (!(e instanceof bus.BusError) || !canLogin()) throw e;
    console.log(e.message);
    await logIn();
    me = await bus.whoami();
  }
  console.log(`Logged in as ${me?.login ?? '?'}`);
  if (opt.login) return;
  await bus.syncClock(12);

  const latest = await bus.latestTicket();
  if (latest?.status) console.log(`Your latest ticket: #${latest.id} ${latest.status}`);

  const items = await bus.loadItems();
  if (!items.length) throw new bus.BusError('No buses found.');
  if (opt.list) return printMenu(items);

  const targets = opt.routes.length ? opt.routes.map(q => matchRoute(items, q)) : await pickInteractive(items);
  console.log(`\nPlan: ${targets.map(t => bus.label(t.route)).join('  then  ')}\n`);

  bus.keepAwake();
  const r = await bus.runPlan(targets.map(t => t.route), {
    early: opt.early,
    interval: opt.interval,
    duration: opt.duration,
    dryRun: opt.dryRun,
    log,
    tick: opensAt => tty && process.stdout.write(`\r\x1b[K  opens in ${bus.dur(opensAt - bus.serverNow())}`),
    relogin: canLogin() ? deadline => logIn(deadline) : undefined,
  });
  log(`\n${bus.describeResult(r)}`);
  if ((r.ok && !r.dry) || r.already) {
    const t = await bus.latestTicket();
    if (t) console.log('Your ticket:', inspect(t, { depth: 2, breakLength: 120 }));
  }
  if (!r.ok && !r.already) process.exitCode = 1;
}

async function logIn(deadline) {
  bus.saveCookie(await relogin({ deadline, log }));
}

function printMenu(items) {
  console.log('');
  items.forEach((it, i) => {
    const r = it.route;
    let when;
    if (bus.isOpen(r, it.dep)) when = `OPEN NOW  ${bus.takenSeats(it.dep) ?? 0}/${r.bus?.capacity ?? '?'} taken`;
    else if (r.available_time) { const t = bus.nextOpening(r); when = `opens ${bus.clock(t)} (in ${bus.dur(t - bus.serverNow())})`; }
    else when = 'no opening time';
    console.log(`  [${i + 1}] ${bus.label(r).padEnd(36)} id ${String(r.id).padEnd(5)} ${when}`);
  });
}

async function pickInteractive(items) {
  printMenu(items);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const ans = (await rl.question('\nWhich bus? Number, or several in priority order like 2,5: ')).trim();
      const picks = ans.split(/[\s,]+/).filter(Boolean).map(Number);
      if (!picks.length || !picks.every(n => Number.isInteger(n) && items[n - 1])) {
        console.log(`Enter numbers between 1 and ${items.length}.`);
        continue;
      }
      const chosen = picks.map(n => items[n - 1]);
      const bad = chosen.find(it => !it.dep && !it.route.available_time);
      if (bad) { console.log(`${bus.label(bad.route)} has no opening time, pick another.`); continue; }
      return chosen;
    }
  } finally {
    rl.close();
  }
}

function matchRoute(items, q) {
  const byId = items.filter(it => String(it.route.id) === q);
  if (byId.length === 1) return byId[0];
  const hits = items.filter(it => bus.label(it.route).toLowerCase().includes(q.toLowerCase()));
  if (hits.length === 1) return hits[0];
  printMenu(items);
  throw new bus.BusError(hits.length ? `"${q}" matches several buses - be more specific or use the id.` : `No bus matches "${q}".`);
}

function parseArgs(argv) {
  const o = { ...bus.DEFAULTS, routes: [], list: false, login: false, help: false, cookieFile: null };
  const num = (v, a) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) die(`${a} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`Missing value for ${a}`);
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-l': case '--list': o.list = true; break;
      case '--login': o.login = true; break;
      case '--12h': bus.useHour12(true); break;
      case '-r': case '--route': o.routes.push(...next().split(',').map(s => s.trim()).filter(Boolean)); break;
      case '--dry-run': o.dryRun = true; break;
      case '--early': o.early = num(next(), a); break;
      case '--interval': o.interval = Math.max(10, num(next(), a)); break;
      case '--duration': o.duration = num(next(), a); break;
      case '--cookie-file': o.cookieFile = next(); break;
      default: die(`Unknown option ${a} (see --help)`);
    }
  }
  return o;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

await main().catch(e => die(e instanceof bus.BusError ? e.message : e?.stack ?? String(e)));
