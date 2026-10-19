import { PaymentsRecoveryService } from '../src/payments/payments-recovery.service';
import { ProviderRejectedError } from '../src/providers/provider.interface';
import { SimulatedProvider } from '../src/providers/simulated.provider';
import { FakeHttp, respondJson, startFakeHttp } from './fake-http';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

describeE2E('payment lifecycle (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  let hook: FakeHttp;
  const alerts = (kind: string) => hook.requests.map((r) => JSON.parse(r.body)).filter((a) => a.kind === kind);

  beforeAll(async () => {
    hook = await startFakeHttp((_req, res) => respondJson(res, 200, { ok: true }));
    t = await startApp({ ALERT_WEBHOOK_URL: hook.url, PROVIDER_OP_MAX_ATTEMPTS: '3' });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
    hook.requests.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await t.close();
    await hook.close();
    for (const k of ['ALERT_WEBHOOK_URL', 'PROVIDER_OP_MAX_ATTEMPTS']) delete process.env[k];
  });

  const create = (over = {}, k = key()) => t.call('POST', '/payments', newPayment(over), { 'idempotency-key': k });
  const count = async (table: string, where = 'true') => (await t.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n as number;
  const recovery = () => t.app.get(PaymentsRecoveryService);
  const get = async (id: string) => (await t.call('GET', `/payments/${id}`)).body;
  const reject = (code: string, message: string) => new ProviderRejectedError(code, message);

  describe('declined authorization', () => {
    it('persists the failed attempt, answers 402, and replays the same answer for the same key', async () => {
      const k = key();
      const first = await create({ paymentMethod: 'pm_card_declined', sellerId: 'declined' }, k);
      expect(first.status).toBe(402);
      expect(first.body).toMatchObject({
        code: 'payment_declined',
        message: 'Your card was declined.',
        payment: { status: 'failed', failureCode: 'card_declined', failureMessage: 'Your card was declined.' },
      });
      // The attempt is on record (the old design rolled everything back and left no trace).
      const id = first.body.payment.id;
      expect(await get(id)).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
      expect(await count('payments', "status = 'failed'")).toBe(1);

      const replay = await create({ paymentMethod: 'pm_card_declined', sellerId: 'declined' }, k);
      expect(replay.status).toBe(402);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');
      expect(await count('payments')).toBe(1);
    });

    it('moves no money and cannot be captured, voided or refunded afterwards', async () => {
      const id = (await create({ paymentMethod: 'pm_card_declined', capture: true })).body.payment.id;
      expect(await count('journal_entries')).toBe(0);
      expect(await count('sim_provider_transactions')).toBe(0);
      expect((await t.call('POST', `/payments/${id}/capture`)).status).toBe(409);
      expect((await t.call('POST', `/payments/${id}/void`)).status).toBe(409);
      expect((await t.call('POST', `/payments/${id}/refunds`, {}, { 'idempotency-key': key() })).status).toBe(409);
    });

    it('a different key is a brand new attempt', async () => {
      await create({ paymentMethod: 'pm_card_declined' });
      expect((await create({ sellerId: 'second_try' })).status).toBe(201);
      expect(await count('payments')).toBe(2);
    });
  });

  describe('unknown or unconfigured provider', () => {
    it('is rejected up front with nothing recorded, and the key stays usable', async () => {
      const k = key();
      expect((await create({ provider: 'stripe' }, k)).status).toBe(400); // not configured in tests
      expect(await count('payments')).toBe(0);
      expect(await count('idempotency_keys')).toBe(0);
      expect((await create({}, k)).status).toBe(201);
    });
  });

  describe('void', () => {
    it('cancels an authorization: status voided, replayable with a key, and it can no longer be captured', async () => {
      const p = (await create()).body;
      expect(p.status).toBe('authorized');
      const k = key();
      const voided = await t.call('POST', `/payments/${p.id}/void`, undefined, { 'idempotency-key': k });
      expect(voided.status).toBe(200);
      expect(voided.body).toMatchObject({ id: p.id, status: 'voided' });
      const replay = await t.call('POST', `/payments/${p.id}/void`, undefined, { 'idempotency-key': k });
      expect(replay.body).toEqual(voided.body);
      expect(replay.headers.get('idempotent-replayed')).toBe('true');

      expect((await t.call('POST', `/payments/${p.id}/capture`)).status).toBe(409);
      expect((await t.call('POST', `/payments/${p.id}/void`)).status).toBe(409); // already voided
      expect(await count('journal_entries')).toBe(0);
    });

    it('cannot void a captured payment', async () => {
      const p = (await create({ capture: true })).body;
      expect(p.status).toBe('captured');
      expect((await t.call('POST', `/payments/${p.id}/void`)).status).toBe(409);
    });

    it('when the provider refuses to void, the payment stays authorized and can still be captured', async () => {
      const p = (await create()).body;
      jest.spyOn(SimulatedProvider.prototype, 'void').mockRejectedValueOnce(reject('void_not_supported', 'cannot void'));
      const res = await t.call('POST', `/payments/${p.id}/void`);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'void_rejected', payment: { status: 'authorized' } });
      expect((await t.call('POST', `/payments/${p.id}/capture`)).body.status).toBe('captured');
    });
  });

  describe('authorization expiry', () => {
    const backdate = (id: string, interval: string) => t.db.query(`UPDATE payments SET authorized_at = now() - interval '${interval}' WHERE id = $1`, [id]);

    it('voids and expires authorizations nobody captured in time, and leaves fresh ones alone', async () => {
      const stale = (await create({ sellerId: 'stale' })).body;
      const fresh = (await create({ sellerId: 'fresh' })).body;
      await backdate(stale.id, '8 days'); // TTL is 7 days
      const void_ = jest.spyOn(SimulatedProvider.prototype, 'void');

      const swept = await recovery().sweep();
      expect(swept.expired).toEqual([stale.id]);
      expect(await get(stale.id)).toMatchObject({ status: 'expired' });
      expect(await get(fresh.id)).toMatchObject({ status: 'authorized' });
      expect(void_).toHaveBeenCalledTimes(1);
      expect((await t.call('POST', `/payments/${stale.id}/capture`)).status).toBe(409);
      expect((await recovery().sweep()).expired).toEqual([]); // nothing left to do
    });

    it('does not expire a payment whose capture is already requested or captured', async () => {
      const captured = (await create({ capture: true })).body;
      await backdate(captured.id, '30 days');
      expect((await recovery().sweep()).expired).toEqual([]);
      expect(await get(captured.id)).toMatchObject({ status: 'captured' });
    });
  });

  describe('declined capture', () => {
    it('answers 402, leaves the payment authorized with nothing in the ledger, and a retry gets a fresh provider key', async () => {
      const p = (await create()).body;
      const capture = jest
        .spyOn(SimulatedProvider.prototype, 'capture')
        .mockRejectedValueOnce(reject('insufficient_funds', 'Insufficient funds'));
      const declined = await t.call('POST', `/payments/${p.id}/capture`);
      expect(declined.status).toBe(402);
      expect(declined.body).toMatchObject({ code: 'capture_declined', message: 'Insufficient funds', payment: { status: 'authorized' } });
      expect(await count('journal_entries')).toBe(0);

      const retried = await t.call('POST', `/payments/${p.id}/capture`);
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('captured');
      // Per-attempt keys: a provider replays the saved result of a reused key, even a failed one.
      expect(capture.mock.calls.map((c) => c[0].idempotencyKey)).toEqual([`capture:${p.id}:1`, `capture:${p.id}:2`]);
      expect(await count('journal_entries', "kind = 'capture'")).toBe(1);
    });

    it('with capture=true on create: 402 capture_declined, payment stays authorized, and recovery does not retry it forever', async () => {
      const capture = jest.spyOn(SimulatedProvider.prototype, 'capture').mockRejectedValue(reject('card_declined', 'Declined at capture'));
      const res = await create({ capture: true, sellerId: 'cap_decl' });
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ code: 'capture_declined', payment: { status: 'authorized' } });
      await recovery().sweep();
      expect(capture).toHaveBeenCalledTimes(1);
    });
  });

  describe('declined refund', () => {
    it('answers 422, leaves the payment untouched and releases the reservation', async () => {
      const p = (await create({ capture: true })).body;
      jest.spyOn(SimulatedProvider.prototype, 'refund').mockRejectedValueOnce(reject('refund_failed', 'Bank refused'));
      const declined = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 4000 }, { 'idempotency-key': key() });
      expect(declined.status).toBe(422);
      expect(declined.body).toMatchObject({ code: 'refund_rejected', message: 'Bank refused', payment: { status: 'captured', refundedAmount: 0 } });
      expect(await count('refunds', "status = 'failed'")).toBe(1);

      // The reserved amount is free again: refunding everything now works.
      const full = await t.call('POST', `/payments/${p.id}/refunds`, {}, { 'idempotency-key': key() });
      expect(full.status).toBe(201);
      expect(full.body).toMatchObject({ status: 'refunded', refundedAmount: 10000 });
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });
  });

  describe('crash recovery', () => {
    it('takes over an operation whose executor died mid-flight once its lease has expired', async () => {
      const p = (await create()).body;
      // Simulate a process that claimed the capture and died: payment `capturing`, operation `in_flight` with an old claim.
      await t.db.query("UPDATE payments SET status = 'capturing' WHERE id = $1", [p.id]);
      await t.db.query(
        `INSERT INTO provider_operations (payment_id, kind, provider, idempotency_key, request, status, attempts, claimed_at)
         VALUES ($1, 'capture', 'simulated', $2, $3, 'in_flight', 1, now() - interval '10 minutes')`,
        [p.id, `capture:${p.id}:1`, JSON.stringify({ providerRef: p.providerRef, amount: p.amount, currency: 'USD' })],
      );
      const swept = await recovery().sweep();
      expect(swept.advanced).toEqual([p.id]);
      expect(await get(p.id)).toMatchObject({ status: 'captured' });
      expect((await t.db.query("SELECT attempts FROM provider_operations WHERE payment_id = $1 AND kind = 'capture'", [p.id])).rows[0].attempts).toBe(2);
    });

    it('does not steal an operation whose lease is still valid (another executor is working on it)', async () => {
      const p = (await create()).body;
      await t.db.query("UPDATE payments SET status = 'capturing' WHERE id = $1", [p.id]);
      await t.db.query(
        `INSERT INTO provider_operations (payment_id, kind, provider, idempotency_key, request, status, attempts, claimed_at)
         VALUES ($1, 'capture', 'simulated', $2, $3, 'in_flight', 1, now())`,
        [p.id, `capture:${p.id}:1`, JSON.stringify({ providerRef: p.providerRef, amount: p.amount, currency: 'USD' })],
      );
      const capture = jest.spyOn(SimulatedProvider.prototype, 'capture');
      // PROVIDER_OP_LEASE_MS is 2000ms in tests: the sweep waits for the lease, then takes over (never earlier).
      const started = Date.now();
      await recovery().sweep();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(await get(p.id)).toMatchObject({ status: 'captured' });
    });

    it('alerts when an operation keeps failing to complete', async () => {
      const p = (await create()).body;
      await t.db.query("UPDATE payments SET status = 'capturing' WHERE id = $1", [p.id]);
      await t.db.query(
        `INSERT INTO provider_operations (payment_id, kind, provider, idempotency_key, request, status, attempts)
         VALUES ($1, 'capture', 'bad_provider', $2, '{}', 'pending', 3)`,
        [p.id, `capture:${p.id}:1`],
      );
      const swept = await recovery().sweep(); // the provider name is unknown, so the operation can never run
      expect(swept.stuckOperations).toBe(1);
      expect(alerts('provider_operation_stuck')).toHaveLength(1);
      expect(alerts('provider_operation_stuck')[0]).toMatchObject({ severity: 'critical', details: { count: 1 } });
    });
  });
});
