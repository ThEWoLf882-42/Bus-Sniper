import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { AccessError, createAccessVerifier } from '../access.mjs';
import { manageAccess } from '../manage-access.mjs';

function fixture(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, 'bus-access-test-'));
  t.after(() => {
    assert.equal(dirname(realpathSync(dir)), parent);
    assert.ok(basename(dir).startsWith('bus-access-test-'));
    rmSync(dir, { recursive: true, force: true });
  });
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPath = join(dir, 'access-public.pem');
  const licensePath = join(dir, 'access.json');
  writeFileSync(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  function issue(overrides = {}, privateKey = keys.privateKey) {
    const payload = Buffer.from(JSON.stringify({ version: 1, app: 'bus-sniper', logins: ['alice'], expiresAt: null, ...overrides }));
    const envelope = { payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') };
    writeFileSync(licensePath, JSON.stringify(envelope));
    return envelope;
  }
  issue();
  return { dir, publicKeyPath, licensePath, issue };
}

test('signed grants allow only the intended verified login', t => {
  const f = fixture(t);
  const access = createAccessVerifier(f);
  access.assertAllowed({ login: 'alice' });
  access.assertAllowed({ login: 'ALICE' });
  for (const user of [{ login: 'mallory' }, {}, { login: 1 }, { login: ['alice'] }]) {
    assert.throws(() => access.assertAllowed(user), AccessError);
  }
});

test('editing the allowed list or signing with another key is rejected', t => {
  const f = fixture(t);
  const access = createAccessVerifier(f);
  access.assertAllowed({ login: 'alice' }); // prime the cache
  const envelope = JSON.parse(readFileSync(f.licensePath));
  const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  payload.logins.push('mallory');
  envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  writeFileSync(f.licensePath, JSON.stringify(envelope));
  assert.throws(() => access.assertAllowed({ login: 'mallory' }), /Invalid or modified/);
  f.issue({ logins: ['mallory'] }, generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => access.assertAllowed({ login: 'mallory' }), /Invalid or modified/);
});

test('missing, malformed, expired and wrongly scoped grants fail closed', t => {
  const f = fixture(t);
  let now = 100;
  const access = createAccessVerifier({ ...f, now: () => now });
  f.issue({ expiresAt: 200 });
  access.assertAllowed({ login: 'alice' });
  now = 200;
  assert.throws(() => access.assertAllowed({ login: 'alice' }), /expired/);
  // Owner inspection can read an expired list, but cannot make it usable.
  const expired = access.readGrant({ allowExpired: true });
  expired.expiresAt = null;
  expired.logins.push('mallory');
  assert.throws(() => access.assertAllowed({ login: 'mallory' }), /expired/);
  for (const overrides of [{ app: 'another-app' }, { version: 2 }, { logins: [''] }, { expiresAt: 'never' }]) {
    f.issue(overrides);
    assert.throws(() => access.checkConfiguration(), AccessError);
  }
  writeFileSync(f.licensePath, '{bad json');
  assert.throws(() => access.checkConfiguration(), AccessError);
  f.issue();
  access.checkConfiguration();
  rmSync(f.licensePath);
  assert.throws(() => access.checkConfiguration(), /not configured/);
  f.issue();
  rmSync(f.publicKeyPath);
  assert.throws(() => access.checkConfiguration(), /not configured/);
});

test('owner adds and removes individual logins while preserving the signed list and expiry', t => {
  const f = fixture(t);
  const directory = join(f.dir, 'app');
  const ownerDirectory = join(f.dir, 'owner-keys');
  mkdirSync(directory);
  const output = [];
  const options = { directory, ownerDirectory, log: message => output.push(message) };
  const run = (...args) => manageAccess(args, options);
  const licensePath = join(directory, 'access.json');
  const access = createAccessVerifier({ publicKeyPath: join(directory, 'access-public.pem'), licensePath });
  run('init');
  run('add', 'alice');
  assert.deepEqual(access.readGrant().logins, ['alice']);
  run('add', 'BOB', 'alice,charlie');
  assert.deepEqual(access.readGrant().logins, ['alice', 'bob', 'charlie']);
  const futureDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  run('add', 'bob', '--expires', futureDate);
  const expiry = access.readGrant().expiresAt;
  assert.equal(expiry, Date.parse(`${futureDate}T00:00:00.000Z`));
  run('add', 'david');
  run('remove', 'BOB,charlie', 'missing');
  assert.deepEqual(access.readGrant().logins, ['alice', 'david']);
  assert.equal(access.readGrant().expiresAt, expiry);
  access.assertAllowed({ login: 'alice' });
  assert.throws(() => access.assertAllowed({ login: 'bob' }), /Contact Aymane Gimi/);
  run('show');
  assert.match(output.at(-1), /Allowed logins: alice, david/);
  run('remove', 'alice', 'david');
  assert.deepEqual(access.readGrant().logins, []);
  assert.throws(() => access.assertAllowed({ login: 'alice' }), /Access denied/);
  run('show');
  assert.match(output.at(-1), /Allowed logins: \(none\)/);
  run('add', 'eve');
  access.assertAllowed({ login: 'eve' });
  assert.equal(access.readGrant().expiresAt, expiry);

  const before = readFileSync(licensePath, 'utf8');
  for (const args of [['add'], ['remove'], ['add', 'a,,b'], ['add', '--invalid'], ['add', 'bob', '--expires'], ['remove', 'eve', '--expires', futureDate]]) {
    assert.throws(() => run(...args));
    assert.equal(readFileSync(licensePath, 'utf8'), before);
  }
  assert.throws(() => manageAccess(['add', 'mallory'], { ...options, ownerDirectory: join(f.dir, 'missing-keys') }), /private key not found/);
  assert.equal(readFileSync(licensePath, 'utf8'), before);

  // Adding must not legitimize a hand-edited list by signing its contents.
  const envelope = JSON.parse(before);
  const grant = JSON.parse(Buffer.from(envelope.payload, 'base64url'));
  grant.logins.push('mallory');
  envelope.payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  const tampered = JSON.stringify(envelope);
  writeFileSync(licensePath, tampered);
  assert.throws(() => run('add', 'frank'), /Invalid or modified/);
  assert.throws(() => run('remove', 'eve'), /Invalid or modified/);
  assert.equal(readFileSync(licensePath, 'utf8'), tampered);
});

test('core and GUI reject unauthorized accounts without sending a booking', async t => {
  const f = fixture(t);
  for (const name of ['core.mjs', 'access.mjs', 'bus.mjs', 'login.mjs', 'manage-access.mjs', 'gui.mjs', 'gui.html']) {
    copyFileSync(new URL(`../${name}`, import.meta.url), join(f.dir, name));
  }
  const seen = [];
  let authStatus = 200;
  let authUser = undefined;
  const server = createServer((req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/isAuth') {
      res.statusCode = authStatus;
      const login = req.headers.cookie === 'session=alice' ? 'alice' : 'mallory';
      res.end(JSON.stringify(authUser ?? { login }));
    } else if (req.url === '/api/departure/current') {
      res.end(JSON.stringify([{ id: 9, route: { id: 1 } }]));
    } else if (req.url === '/api/tickets/book') {
      res.end(JSON.stringify({ id: 42, status: 'booked' }));
    } else res.end('[]');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const originalOrigin = process.env.BUS_ORIGIN;
  const originalCookie = process.env.BUS_COOKIE;
  process.env.BUS_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  delete process.env.BUS_COOKIE;
  t.after(() => {
    if (originalOrigin === undefined) delete process.env.BUS_ORIGIN; else process.env.BUS_ORIGIN = originalOrigin;
    if (originalCookie === undefined) delete process.env.BUS_COOKIE; else process.env.BUS_COOKIE = originalCookie;
  });
  const core = await import(pathToFileURL(join(f.dir, 'core.mjs')));
  const cookiePath = join(f.dir, 'cookie.txt');
  core.useCookieFile(cookiePath);
  await core.saveCookie('session=alice');
  assert.equal((await core.whoami()).login, 'alice');
  const allowed = await core.runPlan([{ id: 1 }], { duration: 1 });
  assert.equal(allowed.ok, true);
  assert.equal(seen.filter(r => r.path === '/api/tickets/book').length, 1);

  await assert.rejects(core.saveCookie('session=mallory'), /Access denied/);
  assert.equal(readFileSync(cookiePath, 'utf8'), 'session=alice\n');
  await assert.rejects(core.checkCookie('session=mallory'), /Access denied/);
  const fakeJwt = ['e30', Buffer.from(JSON.stringify({ login: 'alice' })).toString('base64url'), 'fake'].join('.');
  await assert.rejects(core.saveCookie(`session=${fakeJwt}`), /Access denied/);
  writeFileSync(cookiePath, 'session=mallory');
  core.reloadCookie();
  await assert.rejects(core.whoami(), /Access denied/);
  await assert.rejects(core.loadItems(), /Access denied/);
  await assert.rejects(core.runPlan([{ id: 1 }], { duration: 1 }), /Access denied/);
  assert.equal(seen.filter(r => r.path === '/api/tickets/book').length, 1);
  assert.ok(!seen.some(r => r.cookie === 'session=mallory' && r.path !== '/api/auth/isAuth'));

  // Reject malformed identity even if the endpoint returns HTTP 200.
  authUser = {};
  await assert.rejects(core.checkCookie('session=alice'), /valid 42 login/);
  authUser = undefined;
  authStatus = 401;
  assert.equal(await core.checkCookie('session=alice'), false);
  await assert.rejects(core.runPlan([{ id: 1 }], { duration: 1 }), /Not logged in/);
  authStatus = 200;

  // Environment cookies go through the same check as the GUI and cookie file.
  process.env.BUS_COOKIE = 'session=mallory';
  core.reloadCookie();
  await assert.rejects(core.runPlan([{ id: 1 }], { duration: 1 }), /Access denied/);
  delete process.env.BUS_COOKIE;
  await core.saveCookie('session=alice');
  f.issue({ logins: ['bob'] });
  await assert.rejects(core.runPlan([{ id: 1 }], { duration: 1 }), /Access denied/);
  f.issue();
  await core.whoami();
  writeFileSync(f.licensePath, '{}');
  await assert.rejects(core.runPlan([{ id: 1 }], { duration: 1 }), /Invalid or modified/);
  assert.equal(seen.filter(r => r.path === '/api/tickets/book').length, 1);

  // CLI exits cleanly before any login or request when access is missing.
  rmSync(f.licensePath);
  const cli = spawnSync(process.execPath, [join(f.dir, 'bus.mjs'), '--list'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Access is not configured/);
  assert.doesNotMatch(cli.stderr, /at .*\.mjs:/);
  const init = spawnSync(process.execPath, [join(f.dir, 'manage-access.mjs'), 'init'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(init.status, 1);
  assert.match(init.stderr, /already exist/);

  // Exercise the actual GUI HTTP boundary without opening any browser.
  f.issue();
  writeFileSync(cookiePath, 'session=mallory');
  const gui = spawn(process.execPath, [join(f.dir, 'gui.mjs')], {
    cwd: f.dir,
    env: { ...process.env, BUS_GUI_PORT: '0', BUS_GUI_NO_OPEN: '1', BUS_BROWSER: 'test-browser-unavailable' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = once(gui, 'exit');
  t.after(async () => { gui.kill(); await exited; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('GUI did not start')), 10000);
    let output = '';
    gui.stdout.on('data', data => {
      output += data;
      const match = output.match(/Bus GUI running at (http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+)/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[1])); }
    });
    gui.once('error', error => { clearTimeout(timeout); reject(error); });
    gui.once('exit', () => { clearTimeout(timeout); reject(new Error('GUI exited before starting')); });
  });
  const headers = { 'x-token': url.searchParams.get('t'), 'content-type': 'application/json' };
  let state;
  for (let i = 0; i < 100; i++) {
    state = await fetch(new URL('/api/state', url), { headers }).then(r => r.json());
    if (state.ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.ready, true);
  assert.equal(state.user, null);
  assert.match(state.authError, /Access denied/);
  assert.match(state.authError, /Contact Aymane Gimi/);
  assert.equal(state.login.busy, false); // denied accounts must not launch repeated login windows
  const denied = await fetch(new URL('/api/cookie', url), { method: 'POST', headers, body: JSON.stringify({ cookie: 'session=mallory' }) });
  assert.equal(denied.status, 403);
  const accepted = await fetch(new URL('/api/cookie', url), { method: 'POST', headers, body: JSON.stringify({ cookie: 'session=alice' }) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).user.login, 'alice');
  f.issue({ logins: ['bob'] });
  const blocked = await fetch(new URL('/api/start', url), { method: 'POST', headers, body: JSON.stringify({ ids: [1] }) });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /Access denied/);
  assert.equal(seen.filter(r => r.path === '/api/tickets/book').length, 1);
  gui.kill();
  await exited;
});
