import { describeE2E, key, newPayment, startApp, TestApp } from './helpers';

const CLIENT = 'sk_client_0123456789abcdef';
const asClient = { authorization: `Bearer ${CLIENT}` };

describeE2E('edge protection (e2e)', () => {
  afterAll(() => {
    // env is shared by later suites in the same process
    for (const k of ['API_KEYS', 'RATE_LIMIT_MAX', 'BODY_LIMIT']) delete process.env[k];
  });

  describe('security headers and body size', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await startApp({ API_KEYS: `${CLIENT}:client`, BODY_LIMIT: '2kb' });
    });
    afterAll(() => t.close());

    it('sets hardening headers and does not advertise the framework', async () => {
      const res = await t.call('GET', '/health/live');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('strict-transport-security')).toContain('max-age=');
      expect(res.headers.get('x-frame-options')).toBeTruthy();
      expect(res.headers.get('x-powered-by')).toBeNull();
    });

    it('rejects a JSON body over BODY_LIMIT with 413 before it reaches a handler', async () => {
      const res = await t.call('POST', '/payments', newPayment({ paymentMethod: 'x'.repeat(5000) }), { ...asClient, 'idempotency-key': key() });
      expect(res.status).toBe(413);
    });

    it('still accepts normal bodies, and webhooks keep their raw bytes for signature checks', async () => {
      const ok = await t.call('POST', '/payments', newPayment({ sellerId: 'edge_ok', capture: true }), { ...asClient, 'idempotency-key': key() });
      expect(ok.status).toBe(201);
      // The simulator signs its own webhook over the exact bytes; confirmation proves rawBody survived the custom parser.
      const confirmed = async () => (await t.call('GET', `/payments/${ok.body.id}`, undefined, asClient)).body.captureConfirmedByProvider;
      for (let i = 0; i < 100 && !(await confirmed()); i++) await new Promise((r) => setTimeout(r, 100));
      expect(await confirmed()).toBe(true);
    });
  });

  describe('rate limiting', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await startApp({ API_KEYS: `${CLIENT}:client`, RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '60000' });
    });
    afterAll(() => t.close());

    it('answers 429 with Retry-After once an IP exceeds the limit, even for unauthenticated calls (throttled before auth)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await t.call('GET', '/sellers/x/balance')).status); // no key
      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      const limited = await t.call('GET', '/sellers/x/balance');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      // A valid key does not buy a fresh budget: the limit is per client IP, so guessing keys cannot dodge it.
      expect((await t.call('GET', '/sellers/x/balance', undefined, asClient)).status).toBe(429);
    });

    it('never throttles health checks or provider webhooks', async () => {
      for (let i = 0; i < 8; i++) expect((await t.call('GET', '/health/live')).status).toBe(200);
      for (let i = 0; i < 8; i++) expect((await t.call('POST', '/webhooks/simulated', { id: 'evt_x' })).status).toBe(401); // bad signature, not 429
    });
  });
});
