import { createHash, timingSafeEqual } from 'crypto';

export type Role = 'client' | 'admin';
export interface ApiKey {
  key: string;
  role: Role;
}

const ROLES: readonly Role[] = ['client', 'admin'];
const MIN_KEY_LENGTH = 16;

/**
 * Parses `API_KEYS="<key>:<role>,<key>:<role>"`. Empty means "auth disabled". Anything malformed
 * throws at startup: a typo must never silently weaken or disable authentication.
 */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
  if (!raw || raw.trim() === '') return [];
  const keys: ApiKey[] = [];
  for (const entry of raw.split(',')) {
    const [key, role, ...extra] = entry.trim().split(':');
    if (!key || !role || extra.length > 0) throw new Error(`API_KEYS entries must look like <key>:<role> (got a malformed entry)`);
    if (!ROLES.includes(role as Role)) throw new Error(`API_KEYS: unknown role "${role}" (expected ${ROLES.join(' or ')})`);
    if (key.length < MIN_KEY_LENGTH) throw new Error(`API_KEYS: keys must be at least ${MIN_KEY_LENGTH} characters`);
    if (keys.some((k) => k.key === key)) throw new Error('API_KEYS: duplicate key');
    keys.push({ key, role: role as Role });
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

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Constant-time lookup: tokens are hashed to a fixed length (so lengths don't leak) and every
 * configured key is compared, with no early exit.
 */
export function authenticate(keys: ApiKey[], token: string | undefined): Role | undefined {
  if (!token) return undefined;
  const presented = digest(token);
  let found: Role | undefined;
  for (const k of keys) {
    if (timingSafeEqual(presented, digest(k.key))) found = k.role;
  }
  return found;
}

/** `admin` may do everything a `client` can. */
export function roleSatisfies(have: Role, need: Role): boolean {
  return have === 'admin' || have === need;
}
