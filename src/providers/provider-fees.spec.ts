import { FakeHttp, respondJson, startFakeHttp } from '../../test/fake-http';
import { loadConfig } from '../config/config';
import { RazorpayProvider } from './razorpay.provider';
import { StripeProvider } from './stripe.provider';

let fake: FakeHttp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const stripe = (base: string) => new StripeProvider(loadConfig({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'w', STRIPE_API_BASE: base, PROVIDER_TIMEOUT_MS: '10000' }));
const razorpay = (base: string) =>
  new RazorpayProvider(loadConfig({ RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', RAZORPAY_API_BASE: base, PROVIDER_TIMEOUT_MS: '10000' }));
const capture = { paymentId: 'p', providerRef: 'pi_1', amount: 10000, currency: 'USD', idempotencyKey: 'k' };

describe('Stripe fees', () => {
  const answer = (latest_charge: unknown) => startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pi_1', latest_charge }));

  it('asks Stripe to expand the balance transaction and reads the fee and the charge id from the expanded charge', async () => {
    fake = await answer({ id: 'ch_1', balance_transaction: { id: 'txn_1', fee: 320, currency: 'usd' } });
    expect(await stripe(fake.url).capture(capture)).toEqual({ reportedRef: 'ch_1', fee: 320 });
    expect(decodeURIComponent(fake.requests[0].body)).toContain('expand[]=latest_charge.balance_transaction');
  });

  it('reports no fee while the balance transaction is not ready (Stripe creates it asynchronously)', async () => {
    fake = await answer({ id: 'ch_1', balance_transaction: null });
    expect(await stripe(fake.url).capture(capture)).toEqual({ reportedRef: 'ch_1', fee: undefined });
  });

  it('still works when latest_charge comes back unexpanded, as a plain id', async () => {
    fake = await answer('ch_9');
    expect(await stripe(fake.url).capture(capture)).toEqual({ reportedRef: 'ch_9', fee: undefined });
  });

  it('does not use a fee that is in another currency than the payment (it would be booked in the wrong unit)', async () => {
    fake = await answer({ id: 'ch_1', balance_transaction: { fee: 290, currency: 'eur' } });
    expect((await stripe(fake.url).capture(capture)).fee).toBeUndefined();
  });

  it.each([[-5], [1.5], ['320'], [null]])('never guesses from a malformed fee (%j)', async (fee) => {
    fake = await answer({ id: 'ch_1', balance_transaction: { fee, currency: 'usd' } });
    expect((await stripe(fake.url).capture(capture)).fee).toBeUndefined();
  });

  it('lists the fee for charges only', async () => {
    fake = await startFakeHttp((_req, res) =>
      respondJson(res, 200, {
        has_more: false,
        data: [
          { id: 'txn_1', type: 'charge', source: 'ch_1', amount: 10000, fee: 320, currency: 'usd', created: 1_800_000_000 },
          { id: 'txn_2', type: 'refund', source: 're_1', amount: -500, fee: 0, currency: 'usd', created: 1_800_000_000 },
        ],
      }),
    );
    const txs = await stripe(fake.url).listTransactions('2027-01-15');
    expect(txs.find((t) => t.id === 'ch_1')).toMatchObject({ type: 'charge', amount: 10000, fee: 320 });
    expect(txs.find((t) => t.id === 're_1')).not.toHaveProperty('fee');
  });
});

describe('Razorpay fees', () => {
  it('takes the fee (which already includes GST) from the capture response', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pay_1', status: 'captured', fee: 24, tax: 4 }));
    expect(await razorpay(fake.url).capture({ ...capture, currency: 'INR', providerRef: 'pay_1' })).toEqual({ reportedRef: 'pay_1', fee: 24 });
  });

  it.each([[null], [undefined], [-1], [2.5], ['24']])('reports no fee for %j', async (fee) => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pay_1', fee }));
    expect((await razorpay(fake.url).capture({ ...capture, providerRef: 'pay_1' })).fee).toBeUndefined();
  });

  it('lists captured payments with their fee', async () => {
    fake = await startFakeHttp((req, res) =>
      respondJson(res, 200, req.url.startsWith('/payments') ? { items: [{ id: 'pay_1', captured: true, amount: 1000, currency: 'INR', fee: 24, created_at: 1_800_000_000 }] } : { items: [] }),
    );
    expect((await razorpay(fake.url).listTransactions('2027-01-15'))[0]).toMatchObject({ id: 'pay_1', type: 'charge', fee: 24 });
  });
});
