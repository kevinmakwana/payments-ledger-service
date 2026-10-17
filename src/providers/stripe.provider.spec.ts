import { ServerResponse } from 'http';
import { FakeHttp, respondJson, startFakeHttp } from '../../test/fake-http';
import { ProviderTimeoutError } from '../common/errors';
import { loadConfig } from '../config/config';
import { StripeProvider } from './stripe.provider';

let fake: FakeHttp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const providerFor = (apiBase: string, timeoutMs = 100) =>
  new StripeProvider(
    loadConfig({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_API_BASE: apiBase,
      PROVIDER_TIMEOUT_MS: String(timeoutMs),
    }),
  );

const authorizeReq = { paymentId: 'p1', amount: 1000, currency: 'USD', idempotencyKey: 'k1:authorize' };

describe('StripeProvider payout idempotency keys', () => {
  const payout = { payoutId: 'po-1', sellerId: 'acct_1', amount: 5000, currency: 'USD' };
  const keysSent = () => fake!.requests.map((r) => r.headers['idempotency-key']);

  it('uses a different key for each attempt, since Stripe replays the saved result of a reused key', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'tr_1' }));
    const provider = providerFor(fake.url);
    await provider.createPayout({ ...payout, attempt: 1 });
    await provider.createPayout({ ...payout, attempt: 2 });
    const [first, second] = keysSent();
    expect(first).toBeDefined();
    expect(second).not.toEqual(first);
  });

  it('reuses the same key when the same attempt is re-sent, so a lost response cannot double-pay', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'tr_1' }));
    const provider = providerFor(fake.url);
    await provider.createPayout({ ...payout, attempt: 1 });
    await provider.createPayout({ ...payout, attempt: 1 });
    const [first, second] = keysSent();
    expect(second).toEqual(first);
  });
});

describe('StripeProvider.listTransactions pagination', () => {
  const txn = (n: number) => ({ id: `txn_${n}`, type: 'charge', source: `ch_${n}`, amount: 1000, currency: 'usd', created: 1_800_000_000 });
  const page = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => txn(from + i));

  it('follows has_more / starting_after until every transaction is collected', async () => {
    fake = await startFakeHttp((req, res) => {
      const after = new URL(req.url, 'http://x').searchParams.get('starting_after');
      if (!after) return respondJson(res, 200, { data: page(1, 100), has_more: true });
      if (after === 'txn_100') return respondJson(res, 200, { data: page(101, 150), has_more: false });
      return respondJson(res, 400, { error: { message: `unexpected cursor ${after}` } });
    });
    const txs = await providerFor(fake.url).listTransactions('2027-01-15');
    expect(txs).toHaveLength(150);
    expect(txs.map((t) => t.id)).toEqual(page(1, 150).map((t) => t.source));
    expect(fake.requests).toHaveLength(2);
  });

  it('fails loudly instead of silently truncating when the API never stops paginating', async () => {
    let n = 0;
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { data: [txn(++n)], has_more: true }));
    await expect(providerFor(fake.url, 5000).listTransactions('2027-01-15')).rejects.toThrow(/more than \d+ pages/);
  });
});

describe('StripeProvider timeouts', () => {
  it('fails a request the server never answers with ProviderTimeoutError', async () => {
    fake = await startFakeHttp(() => undefined); // accepts the connection, never responds
    const started = Date.now();
    await expect(providerFor(fake.url).authorize(authorizeReq)).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('also times out when the response body stalls after the headers', async () => {
    fake = await startFakeHttp((_req, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":'); // never finishes the JSON
    });
    await expect(providerFor(fake.url).authorize(authorizeReq)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('still returns normally when the server answers in time', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pi_1' }));
    await expect(providerFor(fake.url).authorize(authorizeReq)).resolves.toEqual({ providerRef: 'pi_1' });
  });
});
