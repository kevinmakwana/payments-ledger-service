import { PaymentsService } from '../src/payments/payments.service';
import { MonitorService } from '../src/monitoring/monitor.service';
import { AppLogger } from '../src/observability/app-logger';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';

describeE2E('observability (e2e)', () => {
  describe('request ids, error envelope and access logs', () => {
    let t: TestApp;
    const lines: string[] = [];
    const logs = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
    const accessLogs = () => logs().filter((l) => l.msg === 'http_request');

    beforeAll(async () => {
      t = await startApp({ BODY_LIMIT: '2kb' }, { logger: new AppLogger((l) => lines.push(l)) });
      await resetDb(t.db);
    });
    beforeEach(() => {
      lines.length = 0;
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      await t.close();
      delete process.env.BODY_LIMIT;
    });

    it('gives every response an X-Request-Id: generated, or the caller\'s when it is safe', async () => {
      const generated = await t.call('GET', '/health/live');
      expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      expect((await t.call('GET', '/health/live', undefined, { 'x-request-id': 'client-req-42' })).headers.get('x-request-id')).toBe('client-req-42');
      const unsafe = await t.call('GET', '/health/live', undefined, { 'x-request-id': 'has spaces and "quotes"' });
      expect(unsafe.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it.each([
      ['unknown payment', 'GET', '/payments/00000000-0000-4000-8000-000000000000', undefined, {}, 404, 'not_found'],
      ['missing idempotency key', 'POST', '/payments', newPayment(), {}, 400, 'bad_request'],
      ['invalid body', 'POST', '/payments', { amount: -1 }, { 'idempotency-key': 'k-1' }, 400, 'bad_request'],
      ['oversized body', 'POST', '/payments', newPayment({ paymentMethod: 'x'.repeat(5000) }), { 'idempotency-key': 'k-2' }, 413, 'payload_too_large'],
    ])('answers %s with one envelope carrying statusCode, code, message and the request id', async (_n, method, path, body, headers, status, code) => {
      const res = await t.call(method as string, path as string, body, headers as Record<string, string>);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ statusCode: status, code, requestId: res.headers.get('x-request-id') });
      expect(res.body.message).toBeDefined();
    });

    it('keeps domain error codes and extra fields intact inside the envelope', async () => {
      const k = key();
      expect((await t.call('POST', '/payments', newPayment({ amount: 5000 }), { 'idempotency-key': k })).status).toBe(201);
      const conflict = await t.call('POST', '/payments', newPayment({ amount: 5001 }), { 'idempotency-key': k });
      expect(conflict.body).toMatchObject({ statusCode: 409, code: 'idempotency_key_reuse', requestId: conflict.headers.get('x-request-id') });
    });

    it('turns an unexpected error into an opaque 500 (no internals leak) and logs the cause with the same request id', async () => {
      jest.spyOn(PaymentsService.prototype, 'get').mockRejectedValueOnce(new Error('password=hunter2 in connection string'));
      const res = await t.call('GET', '/payments/00000000-0000-4000-8000-000000000001');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ statusCode: 500, code: 'internal_error', message: 'Internal server error', requestId: res.headers.get('x-request-id') });
      expect(JSON.stringify(res.body)).not.toContain('hunter2');
      const logged = logs().find((l) => l.level === 'error' && String(l.msg).includes('hunter2'));
      expect(logged).toBeDefined();
      expect(logged).toMatchObject({ requestId: res.headers.get('x-request-id') });
      expect(logged!.stack).toContain('Error');
    });

    it('writes one structured access log per request with the route pattern, never secrets or bodies', async () => {
      const k = `secret-idempotency-${key()}`;
      const created = await t.call('POST', '/payments?token=do-not-log', newPayment({ sellerId: 'log_seller' }), { 'idempotency-key': k });
      await t.call('GET', `/payments/${created.body.id}`, undefined, { 'x-request-id': 'trace-me' });
      const access = accessLogs();
      const get = access.find((l) => l.requestId === 'trace-me')!;
      expect(get).toMatchObject({ method: 'GET', route: '/payments/:id', status: 200, level: 'info' });
      expect(typeof get.durationMs).toBe('number');
      const dump = lines.join('\n');
      for (const secret of [k, 'do-not-log', 'log_seller']) expect(dump).not.toContain(secret);
    });

    it('does not log health probes', async () => {
      await t.call('GET', '/health/live');
      await t.call('GET', '/health/ready');
      expect(accessLogs().filter((l) => String(l.route).startsWith('/health'))).toEqual([]);
    });

    it('carries an inbound W3C trace id into the log lines of that request', async () => {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      await t.call('GET', '/payments/00000000-0000-4000-8000-000000000002', undefined, { traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
      expect(accessLogs().at(-1)).toMatchObject({ traceId });
    });
  });

  describe('/metrics', () => {
    let t: TestApp;
    const adminHeaders = { authorization: `Bearer ${ADMIN}` };
    const metrics = async () => (await fetch(`${t.url}/metrics`, { headers: adminHeaders })).text();

    beforeAll(async () => {
      t = await startApp({ API_KEYS: `${ADMIN}:admin,${CLIENT}:client` });
      await resetDb(t.db);
    });
    afterAll(async () => {
      await t.close();
      delete process.env.API_KEYS;
    });

    it('is admin-only', async () => {
      expect((await fetch(`${t.url}/metrics`)).status).toBe(401);
      expect((await fetch(`${t.url}/metrics`, { headers: { authorization: `Bearer ${CLIENT}` } })).status).toBe(403);
      const ok = await fetch(`${t.url}/metrics`, { headers: adminHeaders });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
    });

    it('counts requests by method, route pattern and status, and times them', async () => {
      await t.call('GET', '/payments/00000000-0000-4000-8000-000000000003', undefined, adminHeaders);
      await t.call('GET', '/payments/00000000-0000-4000-8000-000000000004', undefined, adminHeaders);
      const text = await metrics();
      expect(text).toMatch(/http_requests_total\{method="GET",route="\/payments\/:id",status="404"\} 2/); // pattern, not raw ids
      expect(text).toContain('http_request_duration_seconds_bucket{');
      expect(text).not.toContain('000000000003');
    });

    it('counts provider calls by provider, operation and outcome', async () => {
      await t.call('POST', '/payments', newPayment({ capture: true, sellerId: 'metrics_seller' }), { ...adminHeaders, 'idempotency-key': key() });
      await t.call('POST', '/payments', newPayment({ paymentMethod: 'pm_card_declined' }), { ...adminHeaders, 'idempotency-key': key() });
      const text = await metrics();
      expect(text).toMatch(/provider_calls_total\{provider="simulated",operation="authorize",outcome="success"\} 1/);
      expect(text).toMatch(/provider_calls_total\{provider="simulated",operation="authorize",outcome="rejected"\} 1/);
      expect(text).toMatch(/provider_calls_total\{provider="simulated",operation="capture",outcome="success"\} 1/);
      expect(text).toContain('provider_call_duration_seconds_bucket{');
    });

    it('counts payout provider calls too (they run in the worker tier)', async () => {
      await t.call('POST', '/payments', newPayment({ capture: true, sellerId: 'payout_metrics' }), { ...adminHeaders, 'idempotency-key': key() });
      const asOf = new Date(Date.now() + 3 * 86_400_000).toISOString();
      await t.call('POST', '/payouts/run', { asOf }, adminHeaders);
      await waitFor(async () => /provider_calls_total\{provider="simulated",operation="payout",outcome="success"\} [1-9]/.test(await metrics()), 15000, 'payout metric');
      expect(await metrics()).toMatch(/provider_call_duration_seconds_bucket\{le="[^"]+",provider="simulated",operation="payout"\}/);
    });

    it('exposes queue depth, dead letters, in-flight payments and ledger consistency', async () => {
      await t.db.query(`INSERT INTO webhook_events (provider, event_id, type, payload, status) VALUES ('simulated','evt_m1','x','{}','dead')`);
      await t.app.get(MonitorService).run(); // sets the ledger gauge
      await waitFor(async () => (await metrics()).includes('queue_jobs{queue="webhooks",state="waiting"}'), 5000, 'queue gauge');
      const text = await metrics();
      expect(text).toMatch(/webhook_events_dead 1/);
      expect(text).toMatch(/queue_jobs\{queue="payouts",state="active"\} \d+/);
      expect(text).toMatch(/ledger_consistent 1/);
      expect(text).toContain('payments_in_flight{status="capturing"} 0');
      expect(text).toContain('process_cpu_user_seconds_total'); // default process metrics
    });

    it('counts raised alerts by kind and severity', async () => {
      await t.db.query("UPDATE account_balances SET balance = balance + 1 WHERE account_id = (SELECT id FROM accounts LIMIT 1)");
      await t.app.get(MonitorService).run();
      const text = await metrics();
      expect(text).toMatch(/alerts_total\{kind="ledger_drift",severity="critical"\} 1/);
      expect(text).toMatch(/ledger_consistent 0/);
    });
  });
});
