// Offline access control: only the owner can sign an allowed-login list.
// This deters edits to the list; someone who modifies this verifier can bypass it.
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class AccessError extends Error {
  constructor(message) { super(message); this.name = 'AccessError'; }
}

export const normalizeLogin = login => typeof login === 'string' ? login.trim().toLowerCase() : '';
export const validLogin = login => typeof login === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(login);

// Paths are fixed relative to the application, never supplied by a login or cookie.
// Read on each check so deleting/replacing a grant fails closed, even when cached.
// Signature verification itself is cached while the two files remain identical.
export function createAccessVerifier({
  publicKeyPath = new URL('./access-public.pem', import.meta.url),
  licensePath = new URL('./access.json', import.meta.url),
  now = Date.now,
} = {}) {
  let cached;
  function readGrant({ allowExpired = false } = {}) {
    let pem, text;
    try {
      pem = readFileSync(publicKeyPath, 'utf8');
      text = readFileSync(licensePath, 'utf8');
    } catch {
      throw new AccessError('Access is not configured. Contact Aymane Gimi for access.');
    }
    if (!cached || cached.pem !== pem || cached.text !== text) {
      cached = undefined;
      try {
        if (pem.length > 4096 || text.length > 65536) throw new Error();
        const envelope = JSON.parse(text);
        const decode = value => {
          if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
          const bytes = Buffer.from(value, 'base64url');
          if (bytes.toString('base64url') !== value) throw new Error();
          return bytes;
        };
        const payload = decode(envelope.payload);
        const signature = decode(envelope.signature);
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payload, key, signature)) throw new Error();
        const grant = JSON.parse(payload.toString('utf8'));
        if (grant.version !== 1 || grant.app !== 'bus-sniper' || !Array.isArray(grant.logins) ||
            !grant.logins.every(validLogin) ||
            !(grant.expiresAt === null || (Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > 0))) throw new Error();
        cached = { pem, text, grant };
      } catch {
        throw new AccessError('Invalid or modified access file. Contact Aymane Gimi for access.');
      }
    }
    if (!allowExpired && cached.grant.expiresAt !== null && now() >= cached.grant.expiresAt) {
      throw new AccessError('Your access file has expired. Contact Aymane Gimi to renew it.');
    }
    return cached.grant;
  }
  return {
    checkConfiguration() { readGrant(); },
    // Owner commands may inspect an expired grant to renew it without retyping
    // its logins. Return a copy so callers cannot mutate the verified cache.
    readGrant(options) {
      const grant = readGrant(options);
      return { ...grant, logins: [...grant.logins] };
    },
    assertAllowed(user) {
      const grant = readGrant();
      const login = normalizeLogin(user?.login);
      if (!validLogin(login)) throw new AccessError('The bus site did not return a valid 42 login. Access denied. Contact Aymane Gimi.');
      if (!grant.logins.includes(login)) throw new AccessError(`Access denied: ${login} is not an allowed 42 login. Contact Aymane Gimi.`);
    },
  };
}

const access = createAccessVerifier();
export const checkAccessConfiguration = () => access.checkConfiguration();
export const assertAllowedLogin = user => access.assertAllowed(user);
