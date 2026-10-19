import { ProviderTimeoutError } from '../src/common/errors';
import { LedgerService } from '../src/ledger/ledger.service';
import { PaymentsRecoveryService } from '../src/payments/payments-recovery.service';
import { SimulatedProvider } from '../src/providers/simulated.provider';
import { signTimestamped } from '../src/providers/signature';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { describeE2E, evt, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

/**
 * Crash/failure injection: break one step of a flow and assert what the outbox design promises afterwards.
 *  - The intent (payment, refund reservation, provider operation) is committed BEFORE any provider call.
 *  - A crash or unknown outcome leaves a durable, resumable record, never a half-applied one.
 *  - A client retry with the same Idempotency-Key, or the recovery worker, converges to exactly ONE provider effect.
 * (The "payout batch committed but its dispatch job was lost" crash is covered in payout-sweeper.e2e-spec.ts.)
 */
describeE2E('failure injection (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => t.close());

  const count = async (table: string, where = 'true') => (await t.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n as number;
  const create = (k: string, over = {}) => t.call('POST', '/payments', newPayment({ capture: true, ...over }), { 'idempotency-key': k });
  const recovery = () => t.app.get(PaymentsRecoveryService);
  const status = async (id: string) => (await t.db.query('SELECT status FROM payments WHERE id = $1', [id])).rows[0].status as string;
  const onlyPaymentId = async () => (await t.db.query('SELECT id FROM payments')).rows[0].id as string;
  const reconciliation = async () => (await t.call('GET', `/reports/reconciliation?date=${today()}`)).body;

  /** The next ledger post is written to the database and then the process "dies" before COMMIT. */
  const crashAfterNextLedgerPost = () => {
    const real = LedgerService.prototype.post;
    return jest.spyOn(LedgerService.prototype, 'post').mockImplementationOnce(async function (this: LedgerService, ...args) {
      await real.apply(this, args);
      throw new Error('injected crash before commit');
    });
  };

  describe('provider captured, but applying the result failed', () => {
    it('keeps a durable intent; a retry with the same key finishes it with ONE provider charge and a clean reconciliation', async () => {
      const k = key();
      const captureCalls = jest.spyOn(SimulatedProvider.prototype, 'capture');
      crashAfterNextLedgerPost();
      expect((await create(k, { sellerId: 'crash_cap' })).status).toBe(500);

      // Nothing was lost or half-applied: the payment is in flight, the ledger has nothing, the key points at the payment.
      const id = await onlyPaymentId();
      expect(await status(id)).toBe('capturing');
      expect(await count('journal_entries')).toBe(0);
      expect(await count('sim_provider_transactions', "type = 'charge'")).toBe(1); // the provider did capture
      expect((await t.db.query('SELECT resource_id FROM idempotency_keys WHERE key = $1', [k])).rows[0].resource_id).toBe(id);

      const retried = await create(k, { sellerId: 'crash_cap' });
      expect(retried.status).toBe(201);
      expect(retried.body).toMatchObject({ id, status: 'captured' });
      expect(retried.headers.get('idempotent-replayed')).toBe('true');
      expect(await count('payments')).toBe(1);
      expect(await count('journal_entries', "kind = 'capture'")).toBe(1);
      expect(await count('sim_provider_transactions', "type = 'charge'")).toBe(1); // still one: same idempotency key
      // The capture was attempted twice with the SAME key, which is what makes the redo safe.
      const keys = captureCalls.mock.calls.map((c) => c[0].idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
      expect(await reconciliation()).toMatchObject({ summary: { matched: 1, mismatches: 0 } }); // no orphaned charge any more
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });

    it('with no client retry at all, the recovery worker completes the payment', async () => {
      crashAfterNextLedgerPost();
      expect((await create(key(), { sellerId: 'crash_rec' })).status).toBe(500);
      const id = await onlyPaymentId();
      expect(await status(id)).toBe('capturing');

      const swept = await recovery().sweep();
      expect(swept.advanced).toEqual([id]);
      expect(await status(id)).toBe('captured');
      expect(await count('journal_entries', "kind = 'capture'")).toBe(1);
      expect(await reconciliation()).toMatchObject({ summary: { matched: 1, mismatches: 0 } });
    });

    it('a refund that dies after the provider refunded stays reserved, then completes on retry exactly once', async () => {
      const p = (await create(key(), { sellerId: 'crash_ref' })).body;
      const k = key();
      crashAfterNextLedgerPost();
      expect((await t.call('POST', `/payments/${p.id}/refunds`, { amount: 3000 }, { 'idempotency-key': k })).status).toBe(500);

      expect((await t.call('GET', `/payments/${p.id}`)).body).toMatchObject({ status: 'captured', refundedAmount: 0 });
      expect(await count('refunds', "status = 'pending'")).toBe(1);
      // The pending refund reserves its amount, so a second refund cannot over-refund while this one is unresolved.
      const tooMuch = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 8000 }, { 'idempotency-key': key() });
      expect(tooMuch.status).toBe(422);

      const retried = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 3000 }, { 'idempotency-key': k });
      expect(retried.status).toBe(201);
      expect(retried.body).toMatchObject({ status: 'partially_refunded', refundedAmount: 3000 });
      expect(await count('refunds', "status = 'succeeded'")).toBe(1);
      expect(await count('sim_provider_transactions', "type = 'refund'")).toBe(1);
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });
  });

  describe('provider outcome unknown (error or timeout)', () => {
    it('a generic provider error keeps the payment in flight; the same key resumes with the same provider idempotency key', async () => {
      const k = key();
      const authorize = jest.spyOn(SimulatedProvider.prototype, 'authorize').mockRejectedValueOnce(new Error('provider 503'));
      expect((await create(k, { sellerId: 'prov_err' })).status).toBe(500);
      const id = await onlyPaymentId();
      expect(await status(id)).toBe('created'); // recorded, not lost, and NOT shown to the customer as a decline

      const retried = await create(k, { sellerId: 'prov_err' });
      expect(retried.status).toBe(201);
      expect(retried.body).toMatchObject({ id, status: 'captured' });
      expect(await count('payments')).toBe(1);
      const keys = authorize.mock.calls.map((c) => c[0].idempotencyKey);
      expect(keys).toEqual([`authorize:${id}`, `authorize:${id}`]);
    });

    it('a provider timeout answers 504 provider_timeout, and the recovery worker later finishes the payment', async () => {
      jest.spyOn(SimulatedProvider.prototype, 'authorize').mockRejectedValueOnce(new ProviderTimeoutError('simulated', 15000));
      const res = await create(key(), { sellerId: 'prov_timeout' });
      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({ code: 'provider_timeout' });
      const id = await onlyPaymentId();
      expect(await status(id)).toBe('created');

      await recovery().sweep();
      expect(await status(id)).toBe('captured'); // capture_requested was recorded with the intent
    });
  });

  describe('webhook stored, but enqueueing failed', () => {
    it('the redelivery of the same event re-enqueues it and it gets processed exactly once', async () => {
      const event = evt('customer.updated', {}); // unknown type: stored, acknowledged, needs no side effects
      const body = JSON.stringify(event);
      const post = () =>
        fetch(`${t.url}/webhooks/simulated`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signature': signTimestamped('whsec_simulated_dev', body, Math.floor(Date.now() / 1000)) },
          body,
        });
      jest.spyOn(WebhooksService.prototype, 'enqueue').mockRejectedValueOnce(new Error('redis blip'));

      expect((await post()).status).toBe(500); // provider will redeliver
      const stored = (await t.db.query('SELECT status FROM webhook_events WHERE event_id = $1', [event.id])).rows[0];
      expect(stored.status).toBe('received'); // persisted, just never queued

      const redelivery = await post();
      expect(redelivery.status).toBe(202);
      expect(await redelivery.json()).toEqual({ received: true, duplicate: true });
      await waitFor(
        async () => (await t.db.query('SELECT status FROM webhook_events WHERE event_id = $1', [event.id])).rows[0].status === 'processed',
        10000,
        'redelivered event processed',
      );
      expect((await t.db.query('SELECT attempts FROM webhook_events WHERE event_id = $1', [event.id])).rows[0].attempts).toBe(1);
      expect(await count('webhook_events')).toBe(1);
    });
  });
});
