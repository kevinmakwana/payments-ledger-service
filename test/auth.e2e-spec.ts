import { describeE2E, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';
const asAdmin = { authorization: `Bearer ${ADMIN}` };
const asClient = { authorization: `Bearer ${CLIENT}` };

describeE2E('API key authentication (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ API_KEYS: `${ADMIN}:admin,${CLIENT}:client` });
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
    delete process.env.API_KEYS; // env is shared by later suites in the same process
  });

  // Every row has 3 entries: jest-each would treat a longer callback than the row as a `done` callback.
  const adminRoutes: [string, string, unknown][] = [
    ['POST', '/payouts/run', {}],
    ['GET', '/payouts', undefined],
    ['GET', '/ledger/trial-balance', undefined],
    ['GET', '/ledger/accounts/platform:clearing:USD', undefined],
    ['GET', '/webhooks/dead-letters', undefined],
    ['GET', '/reports/reconciliation?date=2001-01-01', undefined],
  ];
  const clientRoutes: [string, string, unknown][] = [
    ['GET', '/sellers/acme/balance', undefined],
    ['GET', '/payments/00000000-0000-4000-8000-000000000000', undefined],
  ];

  describe('without a valid key', () => {
    it.each([...adminRoutes, ...clientRoutes, ['POST', '/payments', newPayment()] as [string, string, unknown]])(
      '%s %s -> 401',
      async (method, path, body) => {
        const res = await t.call(method, path, body, method === 'POST' && path === '/payments' ? { 'idempotency-key': key() } : {});
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: 'unauthorized' });
      },
    );

    it('rejects an unknown key with the same 401', async () => {
      const res = await t.call('GET', '/sellers/acme/balance', undefined, { authorization: 'Bearer sk_nope_0123456789abcdef' });
      expect(res.status).toBe(401);
    });
  });

  describe('with a client key', () => {
    it('can use the payment API via Bearer or X-API-Key', async () => {
      const a = await t.call('POST', '/payments', newPayment({ sellerId: 'auth_seller', capture: true }), { ...asClient, 'idempotency-key': key() });
      expect(a.status).toBe(201);
      const b = await t.call('GET', `/payments/${a.body.id}`, undefined, { 'x-api-key': CLIENT });
      expect(b.status).toBe(200);
      expect((await t.call('GET', '/sellers/auth_seller/balance', undefined, asClient)).status).toBe(200);
    });

    it.each(adminRoutes)('is forbidden from admin route %s %s (403)', async (method, path, body) => {
      const res = await t.call(method, path, body, asClient);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'forbidden' });
    });
  });

  describe('with an admin key', () => {
    it.each(adminRoutes)('can call %s %s', async (method, path, body) => {
      const res = await t.call(method, path, body, asAdmin);
      expect(res.status).toBeLessThan(300);
    });

    it('can also use client routes', async () => {
      expect((await t.call('GET', '/sellers/acme/balance', undefined, asAdmin)).status).toBe(200);
    });
  });

  describe('public routes', () => {
    it('health endpoints need no key', async () => {
      expect((await t.call('GET', '/health/live')).status).toBe(200);
      expect((await t.call('GET', '/health/ready')).status).toBe(200);
    });

    it('webhook intake is authenticated by signature, not by API key', async () => {
      const res = await t.call('POST', '/webhooks/simulated', { id: 'evt_x', type: 'x' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'missing_signature' }); // reached the signature check, not the key guard
    });

    it('API docs are served without a key', async () => {
      const res = await fetch(`${t.url}/docs-json`);
      expect(res.status).toBe(200);
    });

    it('the YAML rendering of the API docs works too (exercises the YAML serializer Swagger depends on)', async () => {
      const res = await fetch(`${t.url}/docs-yaml`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/^openapi: 3\./m);
      expect(text).toContain('/payments');
    });

    it('the simulator can still deliver its signed webhooks to this service', async () => {
      const p = (await t.call('POST', '/payments', newPayment({ sellerId: 'auth_hook', capture: true }), { ...asClient, 'idempotency-key': key() })).body;
      await waitFor(
        async () => (await t.call('GET', `/payments/${p.id}`, undefined, asClient)).body.captureConfirmedByProvider,
        10000,
        'capture confirmation through the public webhook route',
      );
    });
  });
});
