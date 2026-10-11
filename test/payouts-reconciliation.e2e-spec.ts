import { describeE2E, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

describeE2E('payouts + reconciliation (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  const in3Days = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  const sale = async (sellerId: string, amount = 10000) =>
    (await t.call('POST', '/payments', newPayment({ sellerId, amount, capture: true }), { 'idempotency-key': key() })).body;
  const bal = async (code: string) => (await t.call('GET', `/ledger/accounts/${code}`)).body.balance;
  const payout = (id: string) => t.call('GET', `/payouts/${id}`).then((r) => r.body);
  const run = (asOf?: string) => t.call('POST', '/payouts/run', asOf ? { asOf } : {}).then((r) => r.body);

  describe('payouts', () => {
    it('holds fresh funds, then pays (matured balance - reserve) and settles via signed webhook', async () => {
      await sale('seller_a');
      await sale('seller_a');
      // 2 x (10000 - 1000 fee) = 18000 owed, but nothing has cleared the 2-day hold yet.
      const early = await run();
      expect(early[0]).toMatchObject({ sellerId: 'seller_a', matured: 0, skipped: expect.any(String) });
      expect((await t.call('GET', '/sellers/seller_a/balance')).body).toMatchObject({ ledgerBalance: 18000, availableForPayout: 0 });

      const batch = await run(in3Days());
      expect(batch[0]).toMatchObject({ sellerId: 'seller_a', matured: 18000, reserve: 500, payoutAmount: 17500 });

      const paid = await waitFor(async () => {
        const p = await payout(batch[0].payoutId);
        return p.status === 'paid' ? p : undefined;
      }, 15000, 'payout paid');
      expect(paid.amount).toBe(17500);
      expect(await bal('seller:seller_a:USD')).toBe(500); // reserve stays with the platform's liability
      expect(await bal('platform:payouts_in_transit:USD')).toBe(0);
      expect(await bal('platform:clearing:USD')).toBe(20000 - 17500);
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });

    it('running the batch twice does not pay the same money twice', async () => {
      await sale('seller_b');
      const [a, b] = await Promise.all([run(in3Days()), run(in3Days())]);
      const created = [...a, ...b].filter((l) => l.payoutId);
      expect(created).toHaveLength(1);
      expect((await t.db.query('SELECT count(*)::int AS n FROM payouts')).rows[0].n).toBe(1);
    });

    it('refunds reduce what is payable', async () => {
      const p = await sale('seller_c');
      await t.call('POST', `/payments/${p.id}/refunds`, { amount: 4000 }, { 'idempotency-key': key() });
      // seller got 9000, refund of 4000 returns 400 of fee => seller bears 3600 => 5400 left, minus 500 reserve.
      const batch = await run(in3Days());
      expect(batch[0].payoutAmount).toBe(4900);
    });

    it('skips sellers below the minimum payout', async () => {
      await sale('seller_d', 650); // net 585 - reserve 500 = 85 < min 100
      const batch = await run(in3Days());
      expect(batch[0]).toMatchObject({ skipped: 'below minimum payout' });
    });

    it('retries a failed payout and eventually pays it (flaky bank)', async () => {
      await sale('flaky_seller');
      const batch = await run(in3Days());
      const p = await waitFor(async () => {
        const x = await payout(batch[0].payoutId);
        return x.status === 'paid' ? x : undefined;
      }, 15000, 'retried payout paid');
      expect(p.attempts).toBe(2);
      expect(await bal('platform:payouts_in_transit:USD')).toBe(0);
    });

    it('marks a payout failed after max attempts and returns the money to the seller', async () => {
      await sale('fail_seller');
      const batch = await run(in3Days());
      const p = await waitFor(async () => {
        const x = await payout(batch[0].payoutId);
        return x.status === 'failed' ? x : undefined;
      }, 15000, 'payout failed');
      expect(p.attempts).toBe(2); // PAYOUT_MAX_ATTEMPTS
      expect(p.lastError).toBe('bank_account_rejected');
      expect(await bal('seller:fail_seller:USD')).toBe(9000); // fully restored
      expect(await bal('platform:payouts_in_transit:USD')).toBe(0);
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });
  });

  describe('reconciliation', () => {
    it('reports a clean day when provider and ledger agree', async () => {
      const p = await sale('recon_seller');
      await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1000 }, { 'idempotency-key': key() });
      const batch = await run(in3Days());
      await waitFor(async () => (await payout(batch[0].payoutId)).status === 'paid', 15000, 'payout paid');

      const r = (await t.call('GET', `/reports/reconciliation?date=${today()}`)).body;
      expect(r.summary).toMatchObject({ providerTransactions: 3, ledgerEntries: 3, matched: 3, mismatches: 0 });
    });

    it('flags an amount mismatch, a missing ledger entry and a missing provider transaction', async () => {
      const a = await sale('recon_a', 10000);
      const b = await sale('recon_b', 20000);
      await sale('recon_c', 30000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9999 } }); // provider says 99.99
      await t.sim.tamper({ remove: b.providerRef }); // provider has no record of this charge
      await t.sim.tamper({ add: { id: 'sim_ch_ghost', type: 'charge', amount: 777, currency: 'USD', createdAt: new Date().toISOString() } });

      const r = (await t.call('GET', `/reports/reconciliation?date=${today()}`)).body;
      expect(r.summary).toMatchObject({ matched: 1, mismatches: 3 });
      const byType = Object.fromEntries(r.mismatches.map((m: { type: string }) => [m.type, m]));
      expect(byType.amount_mismatch).toMatchObject({ ref: a.providerRef, providerAmount: 9999, ledgerAmount: 10000 });
      expect(byType.missing_at_provider).toMatchObject({ ref: b.providerRef, ledgerAmount: 20000 });
      expect(byType.missing_in_ledger).toMatchObject({ ref: 'sim_ch_ghost', providerAmount: 777 });
    });

    it('validates the date and returns an empty report for a quiet day', async () => {
      expect((await t.call('GET', '/reports/reconciliation')).status).toBe(400);
      expect((await t.call('GET', '/reports/reconciliation?date=2026-13-45')).status).toBe(400);
      const r = (await t.call('GET', '/reports/reconciliation?date=2001-01-01')).body;
      expect(r.summary).toMatchObject({ providerTransactions: 0, ledgerEntries: 0, mismatches: 0 });
    });
  });
});
