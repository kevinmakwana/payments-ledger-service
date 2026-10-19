import { ProviderRejectedError } from '../src/providers/provider.interface';
import { SimulatedProvider } from '../src/providers/simulated.provider';
import { describeE2E, resetDb, startApp, TestApp } from './helpers';

/**
 * The outbox re-executes provider calls (client retry, recovery worker, lease expiry), so the simulator must
 * behave like a real provider: the same idempotency key yields the same result and only one effect.
 */
describeE2E('simulated provider idempotency (e2e, real Postgres)', () => {
  let t: TestApp;
  let sim: SimulatedProvider;
  beforeAll(async () => {
    t = await startApp();
    sim = t.app.get(SimulatedProvider);
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  const books = async () => (await t.db.query('SELECT id, type, amount FROM sim_provider_transactions ORDER BY id')).rows;
  const auth = (key: string, paymentMethod?: string) =>
    sim.authorize({ paymentId: 'p', amount: 1000, currency: 'USD', idempotencyKey: key, paymentMethod });

  it('authorize: same key -> same reference, different keys -> different references', async () => {
    const a = await auth('k1');
    expect(await auth('k1')).toEqual(a);
    expect((await auth('k2')).providerRef).not.toBe(a.providerRef);
  });

  it('capture: running twice records one charge and returns the same reference', async () => {
    const req = { paymentId: 'p', providerRef: 'sim_ch_x', amount: 1000, currency: 'USD', idempotencyKey: 'capture:p:1' };
    const first = await sim.capture(req);
    const second = await sim.capture(req);
    expect(second).toEqual(first);
    expect(await books()).toEqual([{ id: 'sim_ch_x', type: 'charge', amount: 1000 }]);
  });

  it('refund: running twice records one refund and returns the same reference', async () => {
    const req = { refundId: 'r1', providerRef: 'sim_ch_x', amount: 400, currency: 'USD', idempotencyKey: 'refund:r1' };
    const first = await sim.refund(req);
    expect(await sim.refund(req)).toEqual(first);
    expect(await books()).toHaveLength(1);
  });

  it('payout: same payout + attempt is one transfer; a new attempt is a new transfer', async () => {
    const req = { payoutId: 'po1', sellerId: 'acme', amount: 5000, currency: 'USD', attempt: 1 };
    const first = await sim.createPayout(req);
    expect(await sim.createPayout(req)).toEqual(first);
    expect((await sim.createPayout({ ...req, attempt: 2 })).payoutRef).not.toBe(first.payoutRef);
    expect(await books()).toHaveLength(2);
  });

  it('declines a card when the payment method is pm_card_declined, as a definitive rejection', async () => {
    const err = await auth('k3', 'pm_card_declined').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect(err).toMatchObject({ code: 'card_declined' });
  });

  it('void succeeds and is repeatable', async () => {
    const req = { paymentId: 'p', providerRef: 'sim_ch_x', idempotencyKey: 'void:p' };
    await expect(sim.void(req)).resolves.toBeUndefined();
    await expect(sim.void(req)).resolves.toBeUndefined();
  });
});
