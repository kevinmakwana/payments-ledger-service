import { ProviderTimeoutError } from '../src/common/errors';
import { LedgerService } from '../src/ledger/ledger.service';
import { SimulatedProvider } from '../src/providers/simulated.provider';
import { signTimestamped } from '../src/providers/signature';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { describeE2E, evt, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

/**
 * Crash/failure injection: break one step of a flow and assert what the design promises afterwards.
 * (The "payout batch committed but its dispatch job was never enqueued" crash is covered in payout-sweeper.e2e-spec.ts.)
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

  const count = async (table: string) => (await t.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
  const create = (k: string, over = {}) => t.call('POST', '/payments', newPayment({ capture: true, ...over }), { 'idempotency-key': k });

  /** Make the next ledger post succeed in the database, then blow up: the process "dies" just before COMMIT. */
  const crashAfterNextLedgerPost = () => {
    const real = LedgerService.prototype.post;
    return jest.spyOn(LedgerService.prototype, 'post').mockImplementationOnce(async function (this: LedgerService, ...args) {
      await real.apply(this, args);
      throw new Error('injected crash before commit');
    });
  };

  describe('provider succeeded, our transaction did not commit', () => {
    it('leaves no local trace, keeps the idempotency key reusable, and reconciliation exposes the orphaned charge', async () => {
      const k = key();
      crashAfterNextLedgerPost();
      const failed = await create(k, { sellerId: 'crash_cap' });
      expect(failed.status).toBe(500);

      // Everything the transaction wrote (payment, journal entry, postings, balances, idempotency key) rolled back together.
      for (const table of ['payments', 'journal_entries', 'postings', 'idempotency_keys']) expect(await count(table)).toBe(0);
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
      // ...but the provider did capture the money. This is the gap reconciliation exists to find.
      expect(await count('sim_provider_transactions')).toBe(1);
      const orphan = (await t.call('GET', `/reports/reconciliation?date=${today()}`)).body;
      expect(orphan.summary).toMatchObject({ providerTransactions: 1, ledgerEntries: 0, mismatches: 1 });
      expect(orphan.mismatches[0]).toMatchObject({ type: 'missing_in_ledger', kind: 'charge', providerAmount: 10000 });

      // The client retries with the same key: it is processed normally, exactly once.
      const retried = await create(k, { sellerId: 'crash_cap' });
      expect(retried.status).toBe(201);
      expect(retried.headers.get('idempotent-replayed')).toBeNull();
      expect(await count('payments')).toBe(1);
      expect(await count('journal_entries')).toBe(1);
      const again = await create(k, { sellerId: 'crash_cap' });
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body.id).toBe(retried.body.id);
      // Only the orphaned first attempt is unexplained now.
      const after = (await t.call('GET', `/reports/reconciliation?date=${today()}`)).body;
      expect(after.summary).toMatchObject({ matched: 1, mismatches: 1 });
    });

    it('a refund that dies before commit changes nothing locally and can be retried with the same key', async () => {
      const p = (await create(key(), { sellerId: 'crash_ref' })).body;
      const k = key();
      crashAfterNextLedgerPost();
      expect((await t.call('POST', `/payments/${p.id}/refunds`, { amount: 3000 }, { 'idempotency-key': k })).status).toBe(500);
      expect(await count('refunds')).toBe(0);
      expect((await t.call('GET', `/payments/${p.id}`)).body).toMatchObject({ status: 'captured', refundedAmount: 0 });
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);

      const retried = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 3000 }, { 'idempotency-key': k });
      expect(retried.status).toBe(201);
      expect(retried.body).toMatchObject({ status: 'partially_refunded', refundedAmount: 3000 });
    });
  });

  describe('provider failed before doing anything', () => {
    it('a provider error leaves nothing behind and the same key can be retried', async () => {
      const k = key();
      jest.spyOn(SimulatedProvider.prototype, 'authorize').mockRejectedValueOnce(new Error('provider 503'));
      expect((await create(k, { sellerId: 'prov_err' })).status).toBe(500);
      for (const table of ['payments', 'journal_entries', 'idempotency_keys']) expect(await count(table)).toBe(0);
      expect((await create(k, { sellerId: 'prov_err' })).status).toBe(201);
      expect(await count('payments')).toBe(1);
    });

    it('a provider timeout answers 504 provider_timeout and leaves nothing behind', async () => {
      jest.spyOn(SimulatedProvider.prototype, 'authorize').mockRejectedValueOnce(new ProviderTimeoutError('simulated', 15000));
      const res = await create(key(), { sellerId: 'prov_timeout' });
      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({ code: 'provider_timeout' });
      for (const table of ['payments', 'journal_entries', 'idempotency_keys']) expect(await count(table)).toBe(0);
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
        async () => (await t.db.query('SELECT status, attempts FROM webhook_events WHERE event_id = $1', [event.id])).rows[0].status === 'processed',
        10000,
        'redelivered event processed',
      );
      expect((await t.db.query('SELECT attempts FROM webhook_events WHERE event_id = $1', [event.id])).rows[0].attempts).toBe(1);
      expect(await count('webhook_events')).toBe(1);
    });
  });
});
