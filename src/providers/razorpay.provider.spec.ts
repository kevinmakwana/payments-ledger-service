import { ServerResponse } from 'http';
import { FakeHttp, respondJson, startFakeHttp } from '../../test/fake-http';
import { ProviderTimeoutError } from '../common/errors';
import { loadConfig } from '../config/config';
import { RazorpayProvider } from './razorpay.provider';

let fake: FakeHttp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const providerFor = (apiBase: string, timeoutMs = 100) =>
  new RazorpayProvider(
    loadConfig({
      RAZORPAY_KEY_ID: 'rzp_test_x',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsec_x',
      RAZORPAY_API_BASE: apiBase,
      PROVIDER_TIMEOUT_MS: String(timeoutMs),
    }),
  );

const authorizeReq = { paymentId: 'p1', amount: 1000, currency: 'INR', idempotencyKey: 'k1', paymentMethod: 'pay_1' };

describe('RazorpayProvider.listTransactions pagination', () => {
  const payment = (n: number) => ({ id: `pay_${n}`, captured: true, amount: 1000, currency: 'INR', created_at: 1_800_000_000 });
  const payments = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => payment(from + i));
  const refund = { id: 'rfnd_1', amount: 200, currency: 'INR', payment_id: 'pay_1', created_at: 1_800_000_000 };

  it('pages with skip/count until a short page, for payments and refunds independently', async () => {
    fake = await startFakeHttp((req, res) => {
      const u = new URL(req.url, 'http://x');
      const skip = Number(u.searchParams.get('skip') ?? 0);
      if (u.pathname === '/payments') {
        if (skip === 0) return respondJson(res, 200, { items: payments(1, 100) });
        if (skip === 100) return respondJson(res, 200, { items: payments(101, 130) });
      }
      if (u.pathname === '/refunds' && skip === 0) return respondJson(res, 200, { items: [refund] });
      return respondJson(res, 400, { error: { description: `unexpected ${req.url}` } });
    });
    const txs = await providerFor(fake.url).listTransactions('2027-01-15');
    expect(txs.filter((t) => t.type === 'charge')).toHaveLength(130);
    expect(txs.filter((t) => t.type === 'refund')).toHaveLength(1);
  });

  it('fails loudly instead of silently truncating when the API never returns a short page', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { items: payments(1, 100) }));
    await expect(providerFor(fake.url, 5000).listTransactions('2027-01-15')).rejects.toThrow(/more than \d+ pages/);
  });
});

describe('RazorpayProvider timeouts', () => {
  it('fails a request the server never answers with ProviderTimeoutError', async () => {
    fake = await startFakeHttp(() => undefined);
    const started = Date.now();
    await expect(providerFor(fake.url).authorize(authorizeReq)).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('also times out when the response body stalls after the headers', async () => {
    fake = await startFakeHttp((_req, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
    });
    await expect(providerFor(fake.url).authorize(authorizeReq)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('still returns normally when the server answers in time', async () => {
    fake = await startFakeHttp((_req, res) =>
      respondJson(res, 200, { id: 'pay_1', status: 'authorized', amount: 1000, currency: 'INR' }),
    );
    await expect(providerFor(fake.url).authorize(authorizeReq)).resolves.toEqual({ providerRef: 'pay_1' });
  });
});
