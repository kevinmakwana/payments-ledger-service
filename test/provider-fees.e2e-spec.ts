import { APP_CONFIG } from '../src/config/config';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';
const asAdmin = { authorization: `Bearer ${ADMIN}` };
const asClient = { authorization: `Bearer ${CLIENT}` };

describeE2E('provider fee accounting (e2e)', () => {
  let t: TestApp;
  const today = () => new Date().toISOString().slice(0, 10);
  const balance = async (code: string) => (await t.call('GET', `/ledger/accounts/${code}`, undefined, asAdmin)).body.balance as number;
  const sale = async (sellerId: string, amount = 10000) =>
    (await t.call('POST', '/payments', newPayment({ sellerId, amount, capture: true }), { 'idempotency-key': key(), ...asAdmin })).body;
  const reconcile = async () => (await t.call('GET', `/reports/reconciliation?date=${today()}`, undefined, asAdmin)).body;
  const feeEntries = async (paymentId: string) =>
    (await t.db.query("SELECT kind, reference_key FROM journal_entries WHERE payment_id = $1 AND kind LIKE 'provider_fee%' ORDER BY created_at", [paymentId])).rows;
  const trialBalanced = async () => (await t.call('GET', '/ledger/trial-balance', undefined, asAdmin)).body.balanced as boolean;

  beforeAll(async () => {
    t = await startApp({ API_KEYS: `${ADMIN}:admin,${CLIENT}:client`, SIMULATED_FEE_BPS: '290', SIMULATED_FEE_FIXED_MINOR: '30' });
  });
  beforeEach(() => resetDb(t.db));
  afterAll(async () => {
    await t.close();
    for (const k of ['API_KEYS', 'SIMULATED_FEE_BPS', 'SIMULATED_FEE_FIXED_MINOR']) delete process.env[k];
  });

  describe('at capture', () => {
    it('books the provider fee as an expense taken from the provider balance, and leaves the seller and the platform fee alone', async () => {
      const p = await sale('fees_a', 10000); // provider fee: 2.9% of 10000 + 30 = 320
      expect(await balance('platform:provider_fees:USD')).toBe(320);
      expect(await balance('platform:clearing:USD')).toBe(10000 - 320);
      expect(await balance('platform:fees:USD')).toBe(1000); // the platform's own fee revenue is unchanged
      expect(await balance('seller:fees_a:USD')).toBe(9000); // so is the seller's share
      expect(await trialBalanced()).toBe(true);
      expect((await feeEntries(p.id)).map((e) => e.kind)).toEqual(['provider_fee']);
    });

    it('books it once even if the capture is replayed', async () => {
      const p = (await t.call('POST', '/payments', newPayment({ sellerId: 'fees_replay' }), { 'idempotency-key': key(), ...asAdmin })).body;
      const k = key();
      await t.call('POST', `/payments/${p.id}/capture`, undefined, { 'idempotency-key': k, ...asAdmin });
      await t.call('POST', `/payments/${p.id}/capture`, undefined, { 'idempotency-key': k, ...asAdmin });
      expect(await feeEntries(p.id)).toHaveLength(1);
      expect(await balance('platform:provider_fees:USD')).toBe(320);
    });

    it('never charges more fee than the payment itself', async () => {
      await sale('fees_tiny', 20); // 2.9% of 20 + 30 would be 31
      expect(await balance('platform:provider_fees:USD')).toBe(20);
      expect(await trialBalanced()).toBe(true);
    });

    it('is not reversed by a refund: providers keep their fee', async () => {
      const p = await sale('fees_refund', 10000);
      await t.call('POST', `/payments/${p.id}/refunds`, { amount: 10000 }, { 'idempotency-key': key(), ...asAdmin });
      expect(await balance('platform:provider_fees:USD')).toBe(320);
      expect(await trialBalanced()).toBe(true);
    });
  });

  describe('margin report', () => {
    it('shows fee revenue, provider fees and the net per currency, including fee returned on a refund', async () => {
      const p = await sale('margin_a', 10000);
      await sale('margin_b', 20000); // provider fee 610
      let m = (await t.call('GET', '/reports/margin', undefined, asAdmin)).body;
      expect(m.currencies).toEqual([{ currency: 'USD', platformFeeRevenue: 3000, providerFees: 930, netMargin: 2070 }]);
      await t.call('POST', `/payments/${p.id}/refunds`, { amount: 10000 }, { 'idempotency-key': key(), ...asAdmin });
      m = (await t.call('GET', `/reports/margin?from=${today()}&to=${today()}`, undefined, asAdmin)).body;
      expect(m.currencies[0]).toEqual({ currency: 'USD', platformFeeRevenue: 2000, providerFees: 930, netMargin: 1070 });
      expect(m).toMatchObject({ from: today(), to: today() });
    });

    it('filters by day, validates its parameters, and is admin only', async () => {
      await sale('margin_c', 10000);
      expect((await t.call('GET', '/reports/margin?to=2001-01-01', undefined, asAdmin)).body.currencies).toEqual([]);
      expect((await t.call('GET', '/reports/margin?from=2099-01-01', undefined, asAdmin)).body.currencies).toEqual([]);
      expect((await t.call('GET', '/reports/margin?from=yesterday', undefined, asAdmin)).status).toBe(400);
      expect((await t.call('GET', '/reports/margin', undefined, asClient)).status).toBe(403);
      expect((await t.call('GET', '/reports/margin')).status).toBe(401);
    });
  });

  describe('reconciliation', () => {
    it('is clean when the booked fee matches the provider\'s', async () => {
      await sale('rec_ok', 10000);
      expect((await reconcile()).summary).toMatchObject({ matched: 1, mismatches: 0, feesBooked: 0 });
    });

    it('books a fee the provider reports after the capture (a late fee) without raising a discrepancy, exactly once', async () => {
      const cfg = t.app.get<{ simulatedFeeBps: number; simulatedFeeFixedMinor: number }>(APP_CONFIG);
      const [bps, fixed] = [cfg.simulatedFeeBps, cfg.simulatedFeeFixedMinor];
      cfg.simulatedFeeBps = 0; // this capture happens before the provider has computed a fee
      cfg.simulatedFeeFixedMinor = 0;
      const p = await sale('rec_late', 10000);
      cfg.simulatedFeeBps = bps;
      cfg.simulatedFeeFixedMinor = fixed;
      expect(await feeEntries(p.id)).toHaveLength(0);
      await t.sim.tamper({ setFee: { id: p.providerRef, fee: 320 } }); // ... and now it reports one

      const r = await reconcile();
      expect(r.summary).toMatchObject({ matched: 1, mismatches: 0, open: 0, feesBooked: 1 });
      expect(await balance('platform:provider_fees:USD')).toBe(320);
      expect(await balance('platform:clearing:USD')).toBe(10000 - 320);
      expect((await feeEntries(p.id)).map((e) => e.kind)).toEqual(['provider_fee']);
      expect(await trialBalanced()).toBe(true);
      expect((await reconcile()).summary).toMatchObject({ mismatches: 0, feesBooked: 0 });
      expect(await feeEntries(p.id)).toHaveLength(1);
    });

    it('does not book a late fee onto a charge whose amount disagrees: that is the real problem to look at', async () => {
      const cfg = t.app.get<{ simulatedFeeBps: number; simulatedFeeFixedMinor: number }>(APP_CONFIG);
      const [bps, fixed] = [cfg.simulatedFeeBps, cfg.simulatedFeeFixedMinor];
      cfg.simulatedFeeBps = 0;
      cfg.simulatedFeeFixedMinor = 0;
      const p = await sale('rec_late_bad', 10000);
      cfg.simulatedFeeBps = bps;
      cfg.simulatedFeeFixedMinor = fixed;
      await t.sim.tamper({ setAmount: { id: p.providerRef, amount: 9999 } });
      await t.sim.tamper({ setFee: { id: p.providerRef, fee: 320 } });
      const r = await reconcile();
      expect(r.summary).toMatchObject({ feesBooked: 0, open: 1 });
      expect(r.mismatches[0].type).toBe('amount_mismatch');
      expect(await feeEntries(p.id)).toHaveLength(0);
    });

    it('flags a booked fee that differs from the provider\'s as a fee_mismatch item, and book-fee corrects it with an adjustment', async () => {
      const p = await sale('rec_diff', 10000); // booked 320
      await t.sim.tamper({ setFee: { id: p.providerRef, fee: 400 } });
      const r = await reconcile();
      expect(r.summary).toMatchObject({ mismatches: 1, open: 1, new: 1, feesBooked: 0 });
      expect(r.mismatches[0]).toMatchObject({ type: 'fee_mismatch', ref: p.providerRef, providerAmount: 400, ledgerAmount: 320 });

      const fixed = await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/book-fee`, undefined, asAdmin);
      expect(fixed.status).toBe(200);
      expect(fixed.body).toMatchObject({ status: 'resolved', resolution: 'fee_booked', resolvedBy: expect.stringMatching(/^env:/) });
      expect(await balance('platform:provider_fees:USD')).toBe(400);
      expect(await balance('platform:clearing:USD')).toBe(10000 - 400);
      expect((await feeEntries(p.id)).map((e) => e.kind)).toEqual(['provider_fee', 'provider_fee_adjustment']);
      expect(await trialBalanced()).toBe(true);
      expect((await reconcile()).summary).toMatchObject({ mismatches: 0, matched: 1 });

      const again = await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/book-fee`, undefined, asAdmin);
      expect(again.status).toBe(409);
      expect(await balance('platform:provider_fees:USD')).toBe(400); // nothing posted twice
    });

    it('can also lower a booked fee', async () => {
      const p = await sale('rec_down', 10000);
      await t.sim.tamper({ setFee: { id: p.providerRef, fee: 300 } });
      const r = await reconcile();
      await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/book-fee`, undefined, asAdmin);
      expect(await balance('platform:provider_fees:USD')).toBe(300);
      expect(await balance('platform:clearing:USD')).toBe(10000 - 300);
      expect(await trialBalanced()).toBe(true);
      expect((await reconcile()).summary.mismatches).toBe(0);
    });

    it('books each correction as its own entry, so repeated corrections never collide', async () => {
      const p = await sale('rec_repeat', 10000);
      for (const fee of [400, 320, 400]) {
        await t.sim.tamper({ setFee: { id: p.providerRef, fee } });
        const r = await reconcile();
        await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/book-fee`, undefined, asAdmin);
        expect(await balance('platform:provider_fees:USD')).toBe(fee);
      }
      expect(await feeEntries(p.id)).toHaveLength(4);
      expect(await trialBalanced()).toBe(true);
    });

    it('refuses book-fee on anything that is not a fee mismatch', async () => {
      const p = await sale('rec_amt', 10000);
      await t.sim.tamper({ setAmount: { id: p.providerRef, amount: 9999 } });
      const r = await reconcile();
      expect(r.mismatches[0].type).toBe('amount_mismatch');
      const res = await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/book-fee`, undefined, asAdmin);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('not_a_fee_mismatch');
      expect((await t.call('POST', '/reports/reconciliation/items/00000000-0000-4000-8000-000000000000/book-fee', undefined, asAdmin)).status).toBe(404);
      expect((await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/book-fee`, undefined, asClient)).status).toBe(403);
    });

    it('an ignored fee mismatch stays quiet while the provider\'s figure does not change', async () => {
      const p = await sale('rec_ign', 10000);
      await t.sim.tamper({ setFee: { id: p.providerRef, fee: 321 } });
      const r = await reconcile();
      await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/ignore`, { note: 'one cent rounding' }, asAdmin);
      expect((await reconcile()).summary).toMatchObject({ mismatches: 1, open: 0, new: 0 });
    });
  });
});
