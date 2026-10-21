import { createHash } from 'crypto';
import { parseApiKeys } from '../src/auth/api-keys';
import { describeE2E, resetDb, startApp, TestApp, waitFor } from './helpers';

const BOOTSTRAP = 'sk_bootstrap_0123456789abcdef';
const HASHED_ADMIN = 'sk_hashed_admin_0123456789abcdef';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });
const SELLER_ROUTE = '/sellers/acme/balance';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeE2E('database-backed API keys (e2e)', () => {
  let t: TestApp;
  const env = { API_KEYS: `${BOOTSTRAP}:admin,sha256:${digest(HASHED_ADMIN)}:admin`, API_KEY_CACHE_TTL_MS: '60000' };

  beforeAll(async () => {
    t = await startApp(env);
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
    delete process.env.API_KEYS; // env is shared by later suites in the same process
    delete process.env.API_KEY_CACHE_TTL_MS;
  });

  const create = (body: Record<string, unknown>, as = BOOTSTRAP) => t.call('POST', '/admin/api-keys', body, bearer(as));
  const status = async (k: string, path = SELLER_ROUTE) => (await t.call('GET', path, undefined, bearer(k))).status;

  describe('bootstrap keys from the environment', () => {
    it('accept a plaintext key and a pre-hashed one', async () => {
      expect(await status(BOOTSTRAP)).toBe(200);
      expect(await status(HASHED_ADMIN)).toBe(200);
      expect(await status(HASHED_ADMIN, '/ledger/trial-balance')).toBe(200);
      expect(await status('sk_wrong_0123456789abcdef')).toBe(401);
    });

    it('never keep a plaintext secret in memory-visible config', () => {
      expect(JSON.stringify(parseApiKeys(env.API_KEYS))).not.toContain(BOOTSTRAP);
    });
  });

  describe('issuing keys', () => {
    it('returns the secret once, stores only its SHA-256, and the new key works with its role', async () => {
      const res = await create({ name: 'checkout-backend', role: 'client' });
      expect(res.status).toBe(201);
      const token: string = res.body.key;
      expect(token).toMatch(/^plk_[A-Za-z0-9_-]{43}$/);
      expect(res.body).toMatchObject({ name: 'checkout-backend', role: 'client', status: 'active', keyPrefix: token.slice(0, 8), createdBy: expect.stringMatching(/^env:/) });

      const row = (await t.db.query('SELECT * FROM api_keys WHERE id = $1', [res.body.id])).rows[0];
      expect(row.key_hash.toString('hex')).toBe(digest(token));
      expect(JSON.stringify(row)).not.toContain(token); // the secret is nowhere in the table
      expect(row.key_prefix).toBe(token.slice(0, 8));

      expect(await status(token)).toBe(200); // client routes
      expect(await status(token, '/ledger/trial-balance')).toBe(403); // admin routes
      expect((await t.call('GET', '/admin/api-keys', undefined, bearer(token))).status).toBe(403);
      expect((await create({ name: 'sneaky', role: 'admin' }, token)).status).toBe(403);
    });

    it('lets an issued admin key manage keys, and records who issued what', async () => {
      const admin = (await create({ name: 'ops-admin', role: 'admin' })).body;
      expect(await status(admin.key, '/ledger/trial-balance')).toBe(200);
      const second = await create({ name: 'made-by-db-admin', role: 'client' }, admin.key);
      expect(second.status).toBe(201);
      expect(second.body.createdBy).toBe(admin.id);
    });

    it('works through X-API-Key and on the metrics endpoint too', async () => {
      const k = (await create({ name: 'metrics-scraper', role: 'admin' })).body.key;
      expect((await fetch(`${t.url}/metrics`, { headers: { 'x-api-key': k } })).status).toBe(200);
    });

    it.each([
      ['an unknown role', { name: 'x', role: 'root' }],
      ['a missing name', { role: 'client' }],
      ['an unsafe name', { name: '<script>', role: 'client' }],
      ['a zero lifetime', { name: 'x', role: 'client', expiresInDays: 0 }],
      ['extra fields', { name: 'x', role: 'client', hash: 'abc' }],
    ])('rejects %s', async (_n, body) => {
      expect((await create(body)).status).toBe(400);
    });

    it('requires authentication to manage keys at all', async () => {
      expect((await t.call('POST', '/admin/api-keys', { name: 'x', role: 'client' })).status).toBe(401);
      expect((await t.call('GET', '/admin/api-keys')).status).toBe(401);
    });

    it('does not accept a made-up key in the issued format', async () => {
      expect(await status(`plk_${'A'.repeat(43)}`)).toBe(401);
    });
  });

  describe('listing', () => {
    it('shows metadata only, newest first, paginated', async () => {
      await resetDb(t.db);
      for (const n of ['a', 'b', 'c']) await create({ name: `list-${n}`, role: 'client' });
      const first = (await t.call('GET', '/admin/api-keys?limit=2', undefined, bearer(BOOTSTRAP))).body;
      expect(first.data.map((k: any) => k.name)).toEqual(['list-c', 'list-b']);
      expect(first.nextCursor).toBeTruthy();
      const second = (await t.call('GET', `/admin/api-keys?limit=2&cursor=${first.nextCursor}`, undefined, bearer(BOOTSTRAP))).body;
      expect(second.data.map((k: any) => k.name)).toEqual(['list-a']);
      expect(second.nextCursor).toBeNull();
      const everything = JSON.stringify([...first.data, ...second.data]);
      expect(everything).not.toMatch(/plk_[A-Za-z0-9_-]{43}/);
      expect(everything).not.toContain('key_hash');
      expect(everything).not.toContain('keyHash');
      expect((await t.call('GET', '/admin/api-keys?cursor=garbage', undefined, bearer(BOOTSTRAP))).status).toBe(400);
    });
  });

  describe('revoking', () => {
    it('stops the key working on the very next request, and is idempotent', async () => {
      const k = (await create({ name: 'to-revoke', role: 'client' })).body;
      expect(await status(k.key)).toBe(200); // now cached for 60 s
      const revoked = await t.call('DELETE', `/admin/api-keys/${k.id}`, undefined, bearer(BOOTSTRAP));
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ id: k.id, status: 'revoked' });
      expect(await status(k.key)).toBe(401);
      const again = await t.call('DELETE', `/admin/api-keys/${k.id}`, undefined, bearer(BOOTSTRAP));
      expect(again.status).toBe(200);
      expect(again.body.revokedAt).toBe(revoked.body.revokedAt); // original time kept
    });

    it('404s for an unknown id and 400s for a malformed one', async () => {
      expect((await t.call('DELETE', '/admin/api-keys/00000000-0000-4000-8000-000000000000', undefined, bearer(BOOTSTRAP))).status).toBe(404);
      expect((await t.call('DELETE', '/admin/api-keys/not-a-uuid', undefined, bearer(BOOTSTRAP))).status).toBe(400);
    });

    it('is seen by another instance within API_KEY_CACHE_TTL_MS, not before', async () => {
      const other = await startApp({ ...env, API_KEY_CACHE_TTL_MS: '400' });
      try {
        const k = (await create({ name: 'cross-instance', role: 'client' })).body;
        expect((await other.call('GET', SELLER_ROUTE, undefined, bearer(k.key))).status).toBe(200); // cached there
        await t.call('DELETE', `/admin/api-keys/${k.id}`, undefined, bearer(BOOTSTRAP));
        expect((await other.call('GET', SELLER_ROUTE, undefined, bearer(k.key))).status).toBe(200); // still inside its cache window
        await sleep(500);
        expect((await other.call('GET', SELLER_ROUTE, undefined, bearer(k.key))).status).toBe(401);
      } finally {
        await other.close();
        process.env.API_KEY_CACHE_TTL_MS = '60000';
      }
    });
  });

  describe('expiry', () => {
    it('honours expiresAt even while the key is cached', async () => {
      const k = (await create({ name: 'short-lived', role: 'client', expiresInDays: 1 })).body;
      expect(k.expiresAt).toBeTruthy();
      await t.db.query("UPDATE api_keys SET expires_at = now() + interval '700 milliseconds' WHERE id = $1", [k.id]);
      expect(await status(k.key)).toBe(200); // cached now, for 60 s
      await sleep(900);
      expect(await status(k.key)).toBe(401); // the cache TTL has not elapsed, but the key's own expiry has
      const listed = (await t.call('GET', '/admin/api-keys?limit=200', undefined, bearer(BOOTSTRAP))).body.data.find((x: any) => x.id === k.id);
      expect(listed.status).toBe('expired');
    });
  });

  describe('rotating', () => {
    it('issues a replacement and keeps the old key alive for the grace period only', async () => {
      const old = (await create({ name: 'rotate-me', role: 'client' })).body;
      expect(await status(old.key)).toBe(200);
      const rotated = await t.call('POST', `/admin/api-keys/${old.id}/rotate`, { graceSeconds: 1 }, bearer(BOOTSTRAP));
      expect(rotated.status).toBe(201);
      expect(rotated.body).toMatchObject({ name: 'rotate-me', role: 'client', status: 'active', previous: { id: old.id, replacedBy: rotated.body.id } });
      expect(rotated.body.key).toMatch(/^plk_/);
      expect(rotated.body.key).not.toBe(old.key);
      expect(await status(rotated.body.key)).toBe(200);
      expect(await status(old.key)).toBe(200); // overlap: clients can switch over
      await sleep(1200);
      expect(await status(old.key)).toBe(401);
      expect(await status(rotated.body.key)).toBe(200);
    });

    it('retires the old key at once with graceSeconds 0', async () => {
      const old = (await create({ name: 'rotate-now', role: 'client' })).body;
      expect(await status(old.key)).toBe(200);
      const rotated = await t.call('POST', `/admin/api-keys/${old.id}/rotate`, { graceSeconds: 0 }, bearer(BOOTSTRAP));
      expect(rotated.body.previous.status).toBe('revoked');
      expect(await status(old.key)).toBe(401);
      expect(await status(rotated.body.key)).toBe(200);
    });

    it('cannot rotate a key twice, a revoked key, or an unknown key', async () => {
      const k = (await create({ name: 'once-only', role: 'client' })).body;
      expect((await t.call('POST', `/admin/api-keys/${k.id}/rotate`, {}, bearer(BOOTSTRAP))).status).toBe(201);
      const twice = await t.call('POST', `/admin/api-keys/${k.id}/rotate`, {}, bearer(BOOTSTRAP));
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('api_key_already_rotated');
      const dead = (await create({ name: 'dead', role: 'client' })).body;
      await t.call('DELETE', `/admin/api-keys/${dead.id}`, undefined, bearer(BOOTSTRAP));
      expect((await t.call('POST', `/admin/api-keys/${dead.id}/rotate`, {}, bearer(BOOTSTRAP))).body.code).toBe('api_key_not_active');
      expect((await t.call('POST', '/admin/api-keys/00000000-0000-4000-8000-000000000000/rotate', {}, bearer(BOOTSTRAP))).status).toBe(404);
    });

    it('rejects a grace period that is negative or longer than 30 days', async () => {
      const k = (await create({ name: 'bad-grace', role: 'client' })).body;
      expect((await t.call('POST', `/admin/api-keys/${k.id}/rotate`, { graceSeconds: -1 }, bearer(BOOTSTRAP))).status).toBe(400);
      expect((await t.call('POST', `/admin/api-keys/${k.id}/rotate`, { graceSeconds: 31 * 86400 }, bearer(BOOTSTRAP))).status).toBe(400);
    });
  });

  describe('usage tracking', () => {
    it('records when a key was last used', async () => {
      const k = (await create({ name: 'tracked', role: 'client' })).body;
      expect(k.lastUsedAt).toBeNull();
      await status(k.key);
      await waitFor(async () => (await t.db.query('SELECT last_used_at FROM api_keys WHERE id = $1', [k.id])).rows[0].last_used_at, 5000, 'last_used_at');
    });
  });
});
