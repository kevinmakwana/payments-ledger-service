import { PayoutsService } from '../src/payouts/payouts.service';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

/**
 * A seller can be paid through several providers. Payouts must go back out through the provider that took
 * the money. Only the simulator is configured here, so one payment is re-labelled `razorpay` in SQL to stand
 * for "taken by another provider", and dispatch is stubbed (we assert the batch, not the bank call).
 */
describeE2E('payouts across providers (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  const in3Days = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
    jest.spyOn(PayoutsService.prototype, 'enqueueDispatch').mockResolvedValue(undefined as never);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => t.close());

  const sale = async (sellerId: string, amount: number, provider = 'simulated') => {
    const p = (await t.call('POST', '/payments', newPayment({ sellerId, amount, capture: true }), { 'idempotency-key': key() })).body;
    if (provider !== 'simulated') await t.db.query('UPDATE payments SET provider = $2 WHERE id = $1', [p.id, provider]);
    return p;
  };
  const run = () => t.call('POST', '/payouts/run', { asOf: in3Days() }).then((r) => r.body);
  const payouts = async () =>
    (await t.db.query('SELECT provider, amount FROM payouts ORDER BY provider')).rows as { provider: string; amount: number }[];

  it('routes each provider\'s share of the seller\'s money back through that provider, keeping one reserve per seller', async () => {
    await sale('multi', 10000); // simulated: seller share 9000
    await sale('multi', 20000, 'razorpay'); // razorpay: seller share 18000
    const lines = await run();
    // payable = 27000 - 500 reserve = 26500; razorpay has the most money so it is drained first.
    expect(await payouts()).toEqual([
      { provider: 'razorpay', amount: 18000 },
      { provider: 'simulated', amount: 8500 },
    ]);
    expect(lines.filter((l: { payoutId?: string }) => l.payoutId).map((l: { provider: string }) => l.provider).sort()).toEqual(['razorpay', 'simulated']);
    expect((await t.call('GET', '/sellers/multi/balance')).body.ledgerBalance).toBe(500);
    expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
  });

  it('charges a refund against the provider that took the original payment', async () => {
    const sim = await sale('refunded', 10000);
    await sale('refunded', 20000, 'razorpay');
    await t.call('POST', `/payments/${sim.id}/refunds`, { amount: 4000 }, { 'idempotency-key': key() }); // seller bears 3600 on simulated
    await run();
    // simulated: 9000 - 3600 = 5400; razorpay 18000; payable = 23400 - 500 = 22900
    expect(await payouts()).toEqual([
      { provider: 'razorpay', amount: 18000 },
      { provider: 'simulated', amount: 4900 },
    ]);
  });

  it('does not pay the same money again on the next run (payouts are debits against their own provider)', async () => {
    await sale('twice', 10000);
    await sale('twice', 20000, 'razorpay');
    await run();
    const second = await run();
    expect(second.filter((l: { payoutId?: string }) => l.payoutId)).toEqual([]);
    expect(await payouts()).toHaveLength(2);
  });

  it('skips a provider leg below the minimum payout and leaves that money for a later run', async () => {
    await sale('small_leg', 656); // simulated share 591
    await sale('small_leg', 20000, 'razorpay'); // razorpay share 18000
    const lines = await run();
    // payable = 18591 - 500 = 18091 -> razorpay 18000, simulated leg 91 < minimum 100
    expect(await payouts()).toEqual([{ provider: 'razorpay', amount: 18000 }]);
    expect(lines).toContainEqual(expect.objectContaining({ sellerId: 'small_leg', provider: 'simulated', skipped: 'below minimum payout' }));
  });

  it('single-provider sellers behave exactly as before: one payout through that provider', async () => {
    await sale('single', 10000);
    const lines = await run();
    expect(await payouts()).toEqual([{ provider: 'simulated', amount: 8500 }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sellerId: 'single', matured: 9000, reserve: 500, payoutAmount: 8500, provider: 'simulated' });
  });
});
