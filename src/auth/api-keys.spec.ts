import { authenticateStatic, extractToken, generateToken, hashToken, looksLikeIssuedToken, parseApiKeys, roleSatisfies } from './api-keys';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';

describe('parseApiKeys', () => {
  it('returns no keys when the variable is unset or blank (auth disabled)', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
    expect(parseApiKeys('  ')).toEqual([]);
  });

  it('parses key:role pairs, ignoring whitespace, and keeps only the hash of each key', () => {
    const keys = parseApiKeys(` ${ADMIN}:admin , ${CLIENT}:client `);
    expect(keys.map((k) => [k.role, k.hash.toString('hex'), k.id])).toEqual([
      ['admin', hashToken(ADMIN).toString('hex'), `env:${hashToken(ADMIN).toString('hex').slice(0, 8)}`],
      ['client', hashToken(CLIENT).toString('hex'), `env:${hashToken(CLIENT).toString('hex').slice(0, 8)}`],
    ]);
    expect(JSON.stringify(keys)).not.toContain(ADMIN);
  });

  it('accepts pre-hashed entries, so the secret never has to sit in the environment', () => {
    const digest = hashToken(ADMIN).toString('hex');
    const [key] = parseApiKeys(`sha256:${digest}:admin`);
    expect(key.role).toBe('admin');
    expect(authenticateStatic([key], ADMIN)).toMatchObject({ role: 'admin', source: 'env' });
    expect(authenticateStatic([key], CLIENT)).toBeUndefined();
    expect(parseApiKeys(`sha256:${digest.toUpperCase()}:admin`)[0].hash.equals(key.hash)).toBe(true);
  });

  it('treats a plaintext key and its digest as the same key (so listing both is a duplicate)', () => {
    expect(() => parseApiKeys(`${ADMIN}:admin,sha256:${hashToken(ADMIN).toString('hex')}:client`)).toThrow(/duplicate/);
  });

  it.each([
    ['an unknown role', `${ADMIN}:root`],
    ['a missing role', ADMIN],
    ['a key shorter than 16 characters', 'short:admin'],
    ['a duplicated key', `${ADMIN}:admin,${ADMIN}:client`],
    ['a digest that is not 64 hex characters', 'sha256:abc123:admin'],
    ['a digest entry without a role', `sha256:${'a'.repeat(64)}`],
    ['a digest entry with an unknown role', `sha256:${'a'.repeat(64)}:root`],
  ])('fails fast on %s, so a typo cannot silently weaken auth', (_label, raw) => {
    expect(() => parseApiKeys(raw)).toThrow(/API_KEYS/);
  });
});

describe('extractToken', () => {
  it('reads a Bearer token (scheme is case-insensitive)', () => {
    expect(extractToken({ authorization: `Bearer ${ADMIN}` })).toBe(ADMIN);
    expect(extractToken({ authorization: `bearer ${ADMIN}` })).toBe(ADMIN);
  });

  it('falls back to x-api-key', () => {
    expect(extractToken({ 'x-api-key': CLIENT })).toBe(CLIENT);
  });

  it('prefers Authorization when both are present', () => {
    expect(extractToken({ authorization: `Bearer ${ADMIN}`, 'x-api-key': CLIENT })).toBe(ADMIN);
  });

  it.each([[{}], [{ authorization: 'Basic abc' }], [{ authorization: 'Bearer ' }], [{ 'x-api-key': '' }]])(
    'returns undefined for %j',
    (headers) => {
      expect(extractToken(headers)).toBeUndefined();
    },
  );
});

describe('authenticateStatic', () => {
  const keys = parseApiKeys(`${ADMIN}:admin,${CLIENT}:client`);

  it('returns the principal of a matching key, identified by a non-secret id', () => {
    expect(authenticateStatic(keys, ADMIN)).toEqual({ role: 'admin', keyId: keys[0].id, source: 'env' });
    expect(authenticateStatic(keys, CLIENT)).toMatchObject({ role: 'client', source: 'env' });
    expect(keys[0].id).not.toContain(ADMIN);
  });

  it('rejects unknown, empty and near-miss tokens', () => {
    expect(authenticateStatic(keys, 'nope')).toBeUndefined();
    expect(authenticateStatic(keys, undefined)).toBeUndefined();
    expect(authenticateStatic(keys, ADMIN + 'x')).toBeUndefined();
    expect(authenticateStatic(keys, ADMIN.slice(0, -1))).toBeUndefined();
  });
});

describe('issued tokens', () => {
  it('are 256 random bits in a recognisable format, and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^plk_[A-Za-z0-9_-]{43}$/);
      expect(looksLikeIssuedToken(t)).toBe(true);
    }
  });

  it.each([[''], ['plk_short'], [`plk_${'a'.repeat(44)}`], [`xxx_${'a'.repeat(43)}`], [`plk_${'a'.repeat(42)}!`]])('does not recognise %j', (t) => {
    expect(looksLikeIssuedToken(t)).toBe(false);
  });
});

describe('roleSatisfies', () => {
  it('lets admin do everything a client can, but not the reverse', () => {
    expect(roleSatisfies('admin', 'client')).toBe(true);
    expect(roleSatisfies('admin', 'admin')).toBe(true);
    expect(roleSatisfies('client', 'client')).toBe(true);
    expect(roleSatisfies('client', 'admin')).toBe(false);
  });
});
