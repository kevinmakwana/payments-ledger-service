import { MonitorService } from '../src/monitoring/monitor.service';
import { FakeHttp, respondJson, startFakeHttp } from './fake-http';
import { describeE2E, evt, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

describeE2E('disputes, chargebacks and provider failures (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  let hook: FakeHttp;
  const in3Days = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const in6Days = () => new Date(Date.now() + 6 * 86_400_000).toISOString();
  const alerts = (kind: string) => hook.requests.map((r) => JSON.parse(r.body)).filter((a) => a.kind === kind);

  beforeAll(async () => {
    hook = await startFakeHttp((_req, res) => respondJson(res, 200, { ok: true }));
    // Out-of-order events are retried by the webhook queue: give it room (50ms exponential backoff in tests).
    t = await startApp({ ALERT_WEBHOOK_URL: hook.url, WEBHOOK_MAX_ATTEMPTS: '6' });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
    hook.requests.length = 0;
  });
  afterAll(async () => {
    await t.close();
    await hook.close();
    for (const k of ['ALERT_WEBHOOK_URL', 'WEBHOOK_MAX_ATTEMPTS']) delete process.env[k];
  });

  const sale = async (sellerId: string, amount = 10000) =>
    (await t.call('POST', '/payments', newPayment({ sellerId, amount, capture: true }), { 'idempotency-key': key() })).body;
  const bal = async (code: string) => (await t.call('GET', `/ledger/accounts/${code}`)).body.balance as number;
  const dispute = (p: { providerRef: string }, over: Record<string, unknown> = {}) => ({
    disputeRef: 'dp_1', providerRef: p.providerRef, amount: 10000, currency: 'USD', reason: 'fraudulent', ...over,
  });
  const send = (type: string, data: Record<string, unknown>) => t.sim.deliver(evt(type, data));
  const disputeStatus = async (ref = 'dp_1') => (await t.db.query('SELECT status FROM disputes WHERE provider_ref = $1', [ref])).rows[0]?.status as string | undefined;
  const waitStatus = (status: string, ref = 'dp_1') => waitFor(async () => (await disputeStatus(ref)) === status, 15000, `dispute ${status}`);
  const balanced = async () => (await t.call('GET', '/ledger/trial-balance')).body.balanced as boolean;

  describe('opening a dispute', () => {
    it('withholds the money: provider cash moves to disputed funds and the seller share to the hold account', async () => {
      const p = await sale('disp_open');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      expect(await bal('platform:disputed_funds:USD')).toBe(10000);
      expect(await bal('platform:dispute_holds:USD')).toBe(9000);
      expect(await bal('seller:disp_open:USD')).toBe(0); // 9000 owed - 9000 withheld
      expect(await bal('platform:clearing:USD')).toBe(0); // the provider took it
      expect(await bal('platform:fees:USD')).toBe(1000); // platform fee stands until the outcome is known
      expect(await balanced()).toBe(true);
    });

    it('is idempotent: a duplicate delivery (new event id, same dispute) posts nothing twice', async () => {
      const p = await sale('disp_dup');
      await send('dispute.opened', dispute(p));
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      await t.drain();
      expect((await t.db.query('SELECT count(*)::int AS n FROM disputes')).rows[0].n).toBe(1);
      expect((await t.db.query("SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'dispute_opened'")).rows[0].n).toBe(1);
      expect(await bal('platform:dispute_holds:USD')).toBe(9000);
    });

    it('handles a partial dispute with a pro-rata fee share', async () => {
      const p = await sale('disp_part');
      await send('dispute.opened', dispute(p, { amount: 4000 }));
      await waitStatus('open');
      expect(await bal('platform:disputed_funds:USD')).toBe(4000);
      expect(await bal('platform:dispute_holds:USD')).toBe(3600); // 4000 - floor(1000 * 4000 / 10000)
      expect(await bal('seller:disp_part:USD')).toBe(5400);
    });

    it('ignores inquiries (no funds withdrawn) without touching the ledger', async () => {
      const p = await sale('disp_inq');
      await send('dispute.inquiry', dispute(p));
      await t.drain();
      expect((await t.db.query('SELECT count(*)::int AS n FROM disputes')).rows[0].n).toBe(0);
      expect((await t.db.query("SELECT count(*)::int AS n FROM journal_entries WHERE kind LIKE 'dispute_%'")).rows[0].n).toBe(0);
    });

    it('dead-letters (and alerts) a dispute for a payment we have never heard of', async () => {
      await send('dispute.opened', dispute({ providerRef: 'sim_ch_unknown' }));
      await waitFor(async () => alerts('webhook_dead_lettered').length > 0, 20000, 'dead-letter alert');
      expect(await disputeStatus()).toBeUndefined();
    });
  });

  describe('resolving a dispute', () => {
    it('won: everything is restored as if it never happened', async () => {
      const p = await sale('disp_won');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      await send('dispute.won', dispute(p));
      await waitStatus('won');
      expect(await bal('platform:disputed_funds:USD')).toBe(0);
      expect(await bal('platform:dispute_holds:USD')).toBe(0);
      expect(await bal('seller:disp_won:USD')).toBe(9000);
      expect(await bal('platform:clearing:USD')).toBe(10000);
      expect(await bal('platform:fees:USD')).toBe(1000);
      expect(await balanced()).toBe(true);
    });

    it('lost: exactly the effect of a full refund (seller bears their share, platform returns its fee)', async () => {
      const p = await sale('disp_lost');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      await send('dispute.lost', dispute(p));
      await waitStatus('lost');
      expect(await bal('platform:disputed_funds:USD')).toBe(0);
      expect(await bal('platform:dispute_holds:USD')).toBe(0);
      expect(await bal('seller:disp_lost:USD')).toBe(0);
      expect(await bal('platform:clearing:USD')).toBe(0);
      expect(await bal('platform:fees:USD')).toBe(0);
      expect(await balanced()).toBe(true);
    });

    it('a repeated outcome is a no-op', async () => {
      const p = await sale('disp_twice');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      await send('dispute.won', dispute(p));
      await send('dispute.won', dispute(p));
      await waitStatus('won');
      await t.drain();
      expect((await t.db.query("SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'dispute_won'")).rows[0].n).toBe(1);
    });

    it('an outcome that arrives before the opening is retried until the opening is processed', async () => {
      const p = await sale('disp_order');
      await send('dispute.lost', dispute(p)); // wrong order on purpose
      await send('dispute.opened', dispute(p));
      await waitStatus('lost');
      expect(await bal('seller:disp_order:USD')).toBe(0);
      expect(await balanced()).toBe(true);
    });
  });

  describe('effects on refunds and payouts', () => {
    it('blocks refunds of money that is under dispute, and allows them again once the dispute is won', async () => {
      const p = await sale('disp_refund');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      const blocked = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1000 }, { 'idempotency-key': key() });
      expect(blocked.status).toBe(422);
      await send('dispute.won', dispute(p));
      await waitStatus('won');
      expect((await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1000 }, { 'idempotency-key': key() })).status).toBe(201);
    });

    it('keeps refunds blocked after a loss: that money is gone', async () => {
      const p = await sale('disp_refund_lost');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      await send('dispute.lost', dispute(p));
      await waitStatus('lost');
      expect((await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1 }, { 'idempotency-key': key() })).status).toBe(422);
    });

    it('does not pay out a seller\'s money while it is withheld, and pays it once the dispute is won', async () => {
      const p = await sale('disp_payout');
      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      const held = await t.call('POST', '/payouts/run', { asOf: in3Days() });
      expect(held.body[0]).toMatchObject({ sellerId: 'disp_payout', skipped: expect.any(String) });
      await send('dispute.won', dispute(p));
      await waitStatus('won');
      const paid = await t.call('POST', '/payouts/run', { asOf: in3Days() });
      expect(paid.body[0]).toMatchObject({ sellerId: 'disp_payout', payoutAmount: 8500 });
    });
  });

  describe('negative balances', () => {
    it('shows what a seller owes after a loss that follows a payout, and recovers it from future sales', async () => {
      const p = await sale('disp_neg');
      const first = await t.call('POST', '/payouts/run', { asOf: in3Days() });
      expect(first.body[0].payoutAmount).toBe(8500); // 9000 matured - 500 reserve; the payout is paid by the simulator

      await send('dispute.opened', dispute(p));
      await waitStatus('open');
      await send('dispute.lost', dispute(p));
      await waitStatus('lost');
      await t.drain();
      const owed = (await t.call('GET', '/sellers/disp_neg/balance')).body;
      expect(owed).toMatchObject({ ledgerBalance: -8500, owesPlatform: 8500, availableForPayout: 0 });

      // The monitor flags it so someone can decide whether to collect.
      const raised = await t.app.get(MonitorService).run();
      expect(raised.map((a) => a.kind)).toContain('seller_negative_balance');
      expect(alerts('seller_negative_balance')[0]).toMatchObject({ severity: 'warning', details: { sellers: [{ code: 'seller:disp_neg:USD', owes: 8500 }] } });

      // Nothing is payable until new sales cover the debt...
      const none = await t.call('POST', '/payouts/run', { asOf: in6Days() });
      expect(none.body[0]).toMatchObject({ sellerId: 'disp_neg', skipped: expect.any(String) });
      // ...then new sales are netted against it automatically: 18000 new - 8500 owed - 500 reserve.
      await sale('disp_neg', 20000);
      const recovered = await t.call('POST', '/payouts/run', { asOf: in6Days() });
      expect(recovered.body[0]).toMatchObject({ sellerId: 'disp_neg', payoutAmount: 9000 });
    });
  });

  describe('provider-reported payment failures', () => {
    it('marks a not-yet-captured payment failed with the provider\'s reason', async () => {
      const p = (await t.call('POST', '/payments', newPayment({ sellerId: 'fail_auth' }), { 'idempotency-key': key() })).body;
      expect(p.status).toBe('authorized');
      await send('payment.failed', { providerRef: p.providerRef, reason: 'Authorization expired at the issuer' });
      await waitFor(async () => (await t.call('GET', `/payments/${p.id}`)).body.status === 'failed', 15000, 'payment failed');
      expect((await t.call('GET', `/payments/${p.id}`)).body).toMatchObject({ failureMessage: 'Authorization expired at the issuer' });
      expect((await t.call('POST', `/payments/${p.id}/capture`)).status).toBe(409);
    });

    it('alerts instead of guessing when a failure is reported for money that was already captured', async () => {
      const p = await sale('fail_captured');
      await send('payment.failed', { providerRef: p.providerRef, reason: 'ACH return' });
      await waitFor(async () => alerts('payment_failed_after_capture').length > 0, 15000, 'alert');
      expect((await t.call('GET', `/payments/${p.id}`)).body.status).toBe('captured');
      expect(alerts('payment_failed_after_capture')[0]).toMatchObject({ severity: 'critical', details: { paymentId: p.id } });
    });
  });
});
