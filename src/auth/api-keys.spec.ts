import { authenticate, extractToken, parseApiKeys, roleSatisfies } from './api-keys';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';

describe('parseApiKeys', () => {
  it('returns no keys when the variable is unset or blank (auth disabled)', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
    expect(parseApiKeys('  ')).toEqual([]);
  });

  it('parses key:role pairs, ignoring whitespace', () => {
    expect(parseApiKeys(` ${ADMIN}:admin , ${CLIENT}:client `)).toEqual([
      { key: ADMIN, role: 'admin' },
      { key: CLIENT, role: 'client' },
    ]);
  });

  it.each([
    ['an unknown role', `${ADMIN}:root`],
    ['a missing role', ADMIN],
    ['a key shorter than 16 characters', 'short:admin'],
    ['a duplicated key', `${ADMIN}:admin,${ADMIN}:client`],
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

describe('authenticate', () => {
  const keys = parseApiKeys(`${ADMIN}:admin,${CLIENT}:client`);

  it('returns the role of a matching key', () => {
    expect(authenticate(keys, ADMIN)).toBe('admin');
    expect(authenticate(keys, CLIENT)).toBe('client');
  });

  it('rejects unknown, empty and near-miss tokens', () => {
    expect(authenticate(keys, 'nope')).toBeUndefined();
    expect(authenticate(keys, undefined)).toBeUndefined();
    expect(authenticate(keys, ADMIN + 'x')).toBeUndefined();
    expect(authenticate(keys, ADMIN.slice(0, -1))).toBeUndefined();
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
