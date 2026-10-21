import { createHash, randomBytes, timingSafeEqual } from 'crypto';

export type Role = 'client' | 'admin';

/** A key configured in the environment (`API_KEYS`). Only its SHA-256 is kept in memory, whichever form it was given in. */
export interface ApiKey {
  /** Stable, non-secret label for logs and audit columns: `env:` + the first 8 hex chars of the hash. */
  id: string;
  hash: Buffer;
  role: Role;
}

/** Who is calling, once authenticated. `keyId` is safe to log and store. */
export interface Principal {
  role: Role;
  keyId: string;
  source: 'env' | 'database';
}

const ROLES: readonly Role[] = ['client', 'admin'];
const MIN_KEY_LENGTH = 16;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** Keys issued through the admin API look like `plk_<43 base64url chars>` (256 random bits). */
export const TOKEN_PREFIX = 'plk_';
const ISSUED_TOKEN = /^plk_[A-Za-z0-9_-]{43}$/;
export const generateToken = (): string => TOKEN_PREFIX + randomBytes(32).toString('base64url');
export const looksLikeIssuedToken = (token: string): boolean => ISSUED_TOKEN.test(token);

/**
 * Parses `API_KEYS="<key>:<role>,sha256:<hex digest>:<role>,..."`. Empty means "auth disabled". The second form keeps
 * the secret itself out of the environment (print a digest with `npm run key:generate -- hash <key>`). Anything
 * malformed throws at startup: a typo must never silently weaken or disable authentication.
 */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
  if (!raw || raw.trim() === '') return [];
  const keys: ApiKey[] = [];
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    let hash: Buffer;
    let role: string | undefined;
    if (parts[0] === 'sha256') {
      if (parts.length !== 3 || !SHA256_HEX.test(parts[1])) throw new Error('API_KEYS: sha256 entries must look like sha256:<64 hex chars>:<role>');
      hash = Buffer.from(parts[1], 'hex');
      role = parts[2];
    } else {
      const [key, r, ...extra] = parts;
      if (!key || !r || extra.length > 0) throw new Error(`API_KEYS entries must look like <key>:<role> (got a malformed entry)`);
      if (key.length < MIN_KEY_LENGTH) throw new Error(`API_KEYS: keys must be at least ${MIN_KEY_LENGTH} characters`);
      hash = hashToken(key);
      role = r;
    }
    if (!ROLES.includes(role as Role)) throw new Error(`API_KEYS: unknown role "${role}" (expected ${ROLES.join(' or ')})`);
    if (keys.some((k) => k.hash.equals(hash))) throw new Error('API_KEYS: duplicate key');
    keys.push({ id: `env:${hash.toString('hex').slice(0, 8)}`, hash, role: role as Role });
  }
  return keys;
}

/** `Authorization: Bearer <token>` first, then `X-API-Key`. */
export function extractToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const auth = first(headers['authorization']);
  const bearer = auth && /^bearer\s+(\S+)\s*$/i.exec(auth);
  if (bearer) return bearer[1];
  const apiKey = first(headers['x-api-key'])?.trim();
  return apiKey || undefined;
}

/**
 * Constant-time lookup among the environment keys: the token is hashed to a fixed length (so lengths don't leak)
 * and every configured digest is compared, with no early exit.
 */
export function authenticateStatic(keys: ApiKey[], token: string | undefined): Principal | undefined {
  if (!token) return undefined;
  const presented = hashToken(token);
  let found: ApiKey | undefined;
  for (const k of keys) {
    if (timingSafeEqual(presented, k.hash)) found = k;
  }
  return found && { role: found.role, keyId: found.id, source: 'env' };
}

/** `admin` may do everything a `client` can. */
export function roleSatisfies(have: Role, need: Role): boolean {
  return have === 'admin' || have === need;
}
