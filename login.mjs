// Log in to bus-med through a window of your default browser, then read the
// session cookie straight out of it. The window runs on its own profile in
// ./.login (your normal browsing is never touched); that profile remembers
// your 42 login, so later renewals can usually run invisibly.
// Works with Chrome-family browsers and Firefox. Needs Node 22+ (WebSocket).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, BusError, checkCookie } from './core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = new URL(ORIGIN).hostname;
const LOGIN_URL = `${ORIGIN}/api/auth/42`;

// ---------- which browser ----------

// BUS_BROWSER=/path/to/browser overrides everything. Otherwise the default
// browser; if that can't be driven (Safari), the first installed of these.
export function findBrowser() {
  if (process.env.BUS_BROWSER) return describe(process.env.BUS_BROWSER);
  let def = null;
  try { def = describe(defaultBrowserExe()); } catch {}
  if (def?.kind && existsSync(def.exe)) return def;
  const fallback = fallbacks().map(describe).find(b => b.kind && existsSync(b.exe));
  return fallback && { ...fallback, note: `${def?.name ?? 'your default browser'} can't be used for this` };
}

function describe(exe) {
  if (!exe) return null;
  const file = basename(exe).replace(/\.exe$/i, '');
  // Arc, Safari, flatpak wrappers etc. can't be driven this way (kind: null)
  const name = file.match(/firefox|chromium|chrome|brave|edge|vivaldi|opera|librewolf|waterfox|floorp|safari/i)?.[0].toLowerCase() ?? file;
  const pretty = name[0].toUpperCase() + name.slice(1);
  const kind = /^(firefox|librewolf|waterfox|floorp)$/.test(name) ? 'firefox'
    : /^(chromium|chrome|brave|edge|vivaldi|opera)$/.test(name) ? 'chromium' : null;
  return { kind, name: pretty, exe };
}

function defaultBrowserExe() {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\';
    let progId;
    for (const sub of ['UserChoiceLatest', 'UserChoice']) {
      try { progId = run('reg', ['query', key + sub, '/v', 'ProgId']).match(/ProgId\s+REG_SZ\s+(.+)/)?.[1].trim(); } catch {}
      if (progId) break;
    }
    const cmd = run('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']).match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1].trim();
    return cmd?.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean);
  }
  if (process.platform === 'darwin') {
    let id;
    try {
      const plist = join(homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
      id = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist])).LSHandlers
        ?.find(h => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll;
    } catch {
      const txt = run('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers']);
      id = txt.match(/LSHandlerRoleAll\s*=\s*"?([^";\s]+)"?;\s*LSHandlerURLScheme\s*=\s*https;/)?.[1];
    }
    if (!id || /safari/i.test(id)) return '/Applications/Safari.app/Contents/MacOS/Safari';
    const known = MAC_APPS[id.toLowerCase()];
    const app = (known && ['/Applications', join(homedir(), 'Applications')].map(d => join(d, known)).find(existsSync))
      ?? run('mdfind', [`kMDItemCFBundleIdentifier == "${id}"c`]).split('\n').find(p => p.endsWith('.app'));
    if (!app) return null;
    return join(app, 'Contents/MacOS', run('defaults', ['read', join(app, 'Contents/Info'), 'CFBundleExecutable']).trim());
  }
  // Linux & co: the default browser's .desktop entry says what it runs
  const desktop = run('xdg-settings', ['get', 'default-web-browser']).trim();
  const entry = [join(homedir(), '.local/share/applications'), '/usr/local/share/applications', '/usr/share/applications',
    '/var/lib/snapd/desktop/applications'].map(d => join(d, desktop)).find(existsSync);
  const exec = entry && readFileSync(entry, 'utf8').match(/^Exec=(.*)$/m)?.[1];
  const bin = exec?.split(/\s+/).find(t => t && t !== 'env' && !t.includes('='));
  return bin && (bin.startsWith('/') ? bin : which(bin));
}

const MAC_APPS = {
  'com.google.chrome': 'Google Chrome.app', 'org.mozilla.firefox': 'Firefox.app', 'com.brave.browser': 'Brave Browser.app',
  'org.chromium.chromium': 'Chromium.app', 'com.microsoft.edgemac': 'Microsoft Edge.app', 'com.vivaldi.vivaldi': 'Vivaldi.app',
  'com.operasoftware.opera': 'Opera.app', 'org.mozilla.firefoxdeveloperedition': 'Firefox Developer Edition.app',
};

const which = bin => (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(d => join(d, bin)).find(existsSync);

// never Edge unless it's your default
function fallbacks() {
  if (process.platform === 'win32') {
    const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return ['Google/Chrome/Application/chrome.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe', 'Mozilla Firefox/firefox.exe']
      .flatMap(rel => bases.map(base => join(base, rel)));
  }
  if (process.platform === 'darwin') {
    return ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Brave Browser.app/Contents/MacOS/Brave Browser',
      'Firefox.app/Contents/MacOS/firefox', 'Chromium.app/Contents/MacOS/Chromium']
      .flatMap(rel => ['/Applications', join(homedir(), 'Applications')].map(base => join(base, rel)));
  }
  return ['google-chrome', 'google-chrome-stable', 'brave-browser', 'brave', 'firefox', 'chromium', 'chromium-browser']
    .map(which).filter(Boolean);
}

export const canLogin = () => typeof WebSocket !== 'undefined' && !!findBrowser();

// Renew the login: invisibly first (works while the login window's profile
// still remembers your 42 login), then with a window unless interactive=false.
// Resolves to the cookie header for bus-med.
export async function relogin({ interactive = true, deadline = Infinity, log = () => {}, signal } = {}) {
  const left = () => deadline - Date.now();
  const b = findBrowser();
  if (b && existsSync(join(profileDir(b), OK_MARK))) {
    try {
      return await browserLogin({ silent: true, timeout: Math.min(25_000, left()), log, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      log(`quiet renewal didn't work (${e.message})`);
    }
  }
  if (!interactive) throw new BusError('you need to log in again');
  return browserLogin({ silent: false, timeout: Math.min(5 * 60_000, left()), log, signal });
}

export async function browserLogin({ silent = false, timeout, log = () => {}, signal } = {}) {
  if (typeof WebSocket === 'undefined') throw new BusError('the login window needs Node.js 22 or newer - update Node, or paste the cookie by hand');
  const browser = findBrowser();
  if (!browser) throw new BusError('no Chrome, Edge, Brave or Firefox found for the login window - install one, or paste the cookie by hand');
  if (!(timeout > 0)) throw new BusError('no time left to log in');
  const note = browser.note ? ` (${browser.note}, using ${browser.name})` : '';
  log(silent ? `renewing login in the background${note}` : `opened the login window in ${browser.name}${note} - log in with 42 there, it closes by itself when you're done`);

  const b = await launchBrowser(browser, { headless: silent, url: LOGIN_URL });
  try {
    const end = Date.now() + timeout;
    let tried = '';
    while (Date.now() < end) {
      if (signal?.aborted) throw new BusError('login cancelled');
      if (!(await b.isOpen())) throw new BusError('the login window was closed');
      const cookie = (await b.cookies().catch(() => []))
        .filter(c => { const d = String(c.domain).replace(/^\./, ''); return HOST === d || HOST.endsWith(`.${d}`); })
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
      if (cookie && cookie !== tried) {
        tried = cookie;
        if (await checkCookie(cookie)) {
          writeFileSync(join(profileDir(browser), OK_MARK), new Date().toISOString());
          return cookie;
        }
      }
      await sleep(1000);
    }
    throw new BusError(silent ? 'your 42 login is no longer remembered' : 'login timed out');
  } finally {
    await b.close();
  }
}

// ---------- browser drivers ----------

const profileDir = browser => join(HERE, '.login', browser.name.toLowerCase().replace(/\W+/g, '-'));
const OK_MARK = 'logged-in-once'; // quiet renewal is only worth trying after a real login

export async function launchBrowser(browser, { headless, url }) {
  const profile = profileDir(browser);
  mkdirSync(profile, { recursive: true });
  const port = await freePort();
  const driver = browser.kind === 'firefox' ? firefox : chromium;
  // Some launchers (Edge, Chrome on first run) hand off to another process and
  // exit right away, so the process is only watched for "couldn't start at all";
  // whether the window is still open is asked over the protocol instead.
  const proc = spawn(browser.exe, driver.args({ profile, port, headless, url }), { stdio: 'ignore' });
  let failed = null;
  proc.on('error', e => (failed = e));
  let conn;
  try {
    conn = await driver.connect(port, url, () => failed);
  } catch (e) {
    proc.kill();
    throw new BusError(`could not start ${browser.name} (${failed?.message ?? e.message})`);
  }
  return {
    isOpen: () => driver.isOpen(conn).catch(() => false),
    cookies: () => driver.cookies(conn),
    async close() {
      await Promise.race([driver.quit(conn).catch(() => {}), sleep(3000)]);
      conn.close();
      proc.kill();
    },
  };
}

// Chrome DevTools Protocol
const chromium = {
  args: ({ profile, port, headless, url }) => [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=520,800',
    ...(headless ? ['--headless=new', url] : [`--app=${url}`]),
  ],
  async connect(port, url, failed) {
    const info = await retry(() => fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()), 20_000, failed);
    return rpc(info.webSocketDebuggerUrl);
  },
  isOpen: async conn => (await conn.send('Target.getTargets')).targetInfos.some(t => t.type === 'page'),
  cookies: async conn => (await conn.send('Storage.getCookies')).cookies,
  quit: conn => conn.send('Browser.close'),
};

// WebDriver BiDi (Firefox)
const FIREFOX_PREFS = [
  ['browser.shell.checkDefaultBrowser', false],
  ['browser.aboutwelcome.enabled', false],
  ['trailhead.firstrun.didSeeAboutWelcome', true],
  ['datareporting.policy.dataSubmissionPolicyBypassNotification', true],
  ['toolkit.telemetry.reportingpolicy.firstRun', false],
  ['browser.startup.homepage_override.mstone', 'ignore'],
  ['browser.sessionstore.resume_from_crash', false],
  ['browser.tabs.warnOnClose', false],
  ['remote.active-protocols', 1],
].map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n');

const firefox = {
  args({ profile, port, headless, url }) {
    writeFileSync(join(profile, 'user.js'), `${FIREFOX_PREFS}\n`);
    return ['-profile', profile, '-no-remote', '-new-instance', '--remote-debugging-port', String(port),
      ...(headless ? ['-headless'] : ['-width', '520', '-height', '800']), url];
  },
  async connect(port, url, failed) {
    const conn = await retry(() => rpc(`ws://127.0.0.1:${port}/session`), 30_000, failed);
    await conn.send('session.new', { capabilities: {} });
    const { contexts } = await conn.send('browsingContext.getTree', {});
    const top = contexts?.[0];
    if (top && !top.url.startsWith(ORIGIN) && top.url.startsWith('about:')) {
      await conn.send('browsingContext.navigate', { context: top.context, url, wait: 'none' });
    }
    return conn;
  },
  isOpen: async conn => (await conn.send('browsingContext.getTree', {})).contexts.length > 0,
  cookies: async conn => (await conn.send('storage.getCookies', {})).cookies.map(c => ({ ...c, value: c.value?.value ?? '' })),
  quit: conn => conn.send('browser.close', {}),
};

// minimal JSON-RPC over WebSocket; fits both CDP and BiDi replies
function rpc(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.onerror = () => reject(new Error('connection refused'));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('browser closed'));
      pending.clear();
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.message ?? m.error.message ?? String(m.error)));
      else p.resolve(m.result);
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      close: () => ws.close(),
    });
  });
}

async function retry(fn, ms, failed) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (failed() || Date.now() > end) throw e;
    }
    await sleep(250);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer().on('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
