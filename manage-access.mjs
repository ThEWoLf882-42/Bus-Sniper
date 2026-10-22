#!/usr/bin/env node
// Owner utility. The private key is stored OUTSIDE the shared application folder.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAccessVerifier, normalizeLogin, validLogin } from './access.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER_DIR = join(homedir(), '.bus-sniper-owner');

const HELP = `Owner access management (Node.js 22+)

  node manage-access.mjs init
      Create a public key here and a private key in ~/.bus-sniper-owner/.
      Refuses to replace an existing public key.
  node manage-access.mjs add login1 [login2 ...] [--expires 2026-12-31]
      Add logins while keeping everyone already allowed. Commas also work.
      Creates access.json on the first add. Keeps the current expiry unless set.
  node manage-access.mjs remove login1 [login2 ...]
      Remove only these logins and keep the current expiry.
      Removing the last login leaves a signed list that allows nobody.
  node manage-access.mjs issue login1,login2 [--expires 2026-12-31]
      Replace access.json with a signed list of these exact 42 logins.
      Expiry is optional; a date expires at 00:00 UTC on that date.
  node manage-access.mjs show
      Verify and display the current allowed logins and expiry.

Share access-public.pem and access.json with the app. Never share the owner
key directory. Editing the list invalidates its signature. This local check
can still be bypassed by changing the verifier; it is a deterrent only.
`;

export function manageAccess(args, { directory = HERE, ownerDirectory = OWNER_DIR, log = console.log } = {}) {
  const PUBLIC = join(directory, 'access-public.pem');
  const LICENSE = join(directory, 'access.json');
  const access = createAccessVerifier({ publicKeyPath: PUBLIC, licensePath: LICENSE });
  const keyPath = publicKey => join(ownerDirectory, `${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}.pem`);
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h') return log(HELP);
  if (command === 'init') {
    if (rest.length) throw new Error('init takes no arguments.');
    if (existsSync(PUBLIC) || existsSync(LICENSE)) throw new Error('Access files already exist. Use add or remove to change the allowed logins; keys were not replaced.');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
    const privatePath = keyPath(publicKey);
    writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    writeFileSync(PUBLIC, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
    log(`Public key: ${PUBLIC}\nPrivate key (keep secret and back it up): ${privatePath}\nNext: node manage-access.mjs add login1`);
    return;
  }
  if (['add', 'remove', 'issue'].includes(command)) {
    const { logins: requested, expiresAt: requestedExpiry } = parseLogins(rest, command);
    let grant = { version: 1, app: 'bus-sniper', logins: [], expiresAt: null };
    if (command !== 'issue') {
      if (existsSync(LICENSE)) grant = access.readGrant({ allowExpired: true });
      else if (command === 'remove') throw new Error('No access list yet. Use add to allow a login first.');
    }
    const logins = command === 'add' ? [...new Set([...grant.logins, ...requested])].sort()
      : command === 'remove' ? grant.logins.filter(login => !requested.includes(login)) : requested;
    const expiresAt = requestedExpiry === undefined ? grant.expiresAt : requestedExpiry;
    const publicKey = createPublicKey(readFileSync(PUBLIC));
    let privateKey;
    try { privateKey = createPrivateKey(readFileSync(keyPath(publicKey))); }
    catch { throw new Error('Owner private key not found. Only the owner computer can issue access files.'); }
    if (publicKey.asymmetricKeyType !== 'ed25519' ||
        !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
      throw new Error('Owner key does not match the application public key.');
    }
    const payload = Buffer.from(JSON.stringify({ version: 1, app: 'bus-sniper', logins, expiresAt }));
    const signature = sign(null, payload, privateKey).toString('base64url');
    const text = JSON.stringify({ payload: payload.toString('base64url'), signature }, null, 2) + '\n';
    if (text.length > 65536) throw new Error('Too many logins for one access file. The existing list was not changed.');
    writeFileSync(LICENSE, text);
    access.readGrant({ allowExpired: true });
    if (command === 'add') log(`Added: ${requested.filter(login => !grant.logins.includes(login)).join(', ') || 'none (already allowed)'}`);
    if (command === 'remove') log(`Removed: ${requested.filter(login => grant.logins.includes(login)).join(', ') || 'none (not in the list)'}`);
    log(`Allowed logins: ${logins.join(', ') || '(none)'}\nExpires: ${expiresAt === null ? 'never' : new Date(expiresAt).toISOString()}`);
    return;
  }
  if (command === 'show') {
    if (rest.length) throw new Error('show takes no arguments.');
    const grant = access.readGrant({ allowExpired: true });
    log(`Allowed logins: ${grant.logins.join(', ') || '(none)'}\nExpires: ${grant.expiresAt === null ? 'never' : new Date(grant.expiresAt).toISOString()}`);
    return;
  }
  throw new Error(`Unknown command: ${command}. Use --help.`);
}

function parseLogins(args, command) {
  const names = [];
  let expiresAt;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--expires' && command !== 'remove' && expiresAt === undefined) {
      const date = args[++i] ?? '';
      expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
      if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString().slice(0, 10) !== date || expiresAt <= Date.now()) {
        throw new Error('Expiry must be a future calendar date in YYYY-MM-DD format.');
      }
    } else {
      if (arg.startsWith('-')) throw new Error(`Unknown option for ${command}: ${arg}`);
      names.push(...arg.split(',').map(normalizeLogin));
    }
  }
  if (!names.length || !names.every(validLogin)) throw new Error(`Usage: node manage-access.mjs ${command} login1 [login2 ...]. Supply valid 42 logins.`);
  return { logins: [...new Set(names)].sort(), expiresAt };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { manageAccess(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
