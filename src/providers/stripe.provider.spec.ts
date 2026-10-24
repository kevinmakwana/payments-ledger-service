import { ServerResponse } from 'http';
import { FakeHttp, respondJson, startFakeHttp } from '../../test/fake-http';
import { ProviderTimeoutError } from '../common/errors';
import { loadConfig } from '../config/config';
import { ProviderRejectedError } from './provider.interface';
import { newContext, runWithContext } from '../observability/request-context';
import { signTimestamped } from './signature';
import { StripeProvider } from './stripe.provider';

let fake: FakeHttp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

// Generous by default so a busy machine cannot make happy-path tests time out; timeout tests pass SHORT explicitly.
const SHORT = 100;
const providerFor = (apiBase: string, timeoutMs = 10_000) =>
  new StripeProvider(
    loadConfig({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_API_BASE: apiBase,
      PROVIDER_TIMEOUT_MS: String(timeoutMs),
    }),
  );

const authorizeReq = { paymentId: 'p1', amount: 1000, currency: 'USD', idempotencyKey: 'k1:authorize' };

describe('StripeProvider webhook mapping (disputes and failures)', () => {
  const NOW = 1_800_000_000;
  const parse = (type: string, object: Record<string, unknown>) => {
    const body = JSON.stringify({ id: 'evt_1', type, created: NOW, data: { object } });
    const headers = { 'stripe-signature': signTimestamped('whsec_x', body, NOW) };
    return providerFor('http://unused').parseWebhook(Buffer.from(body), headers, NOW);
  };
  const dispute = { id: 'dp_1', amount: 5000, currency: 'usd', payment_intent: 'pi_1', charge: 'ch_1', reason: 'fraudulent' };

  it('maps a created dispute to dispute.opened with the amount, currency and our payment reference', () => {
    expect(parse('charge.dispute.created', { ...dispute, status: 'needs_response' })).toMatchObject({
      id: 'evt_1',
      type: 'dispute.opened',
      data: { disputeRef: 'dp_1', providerRef: 'pi_1', amount: 5000, currency: 'USD', reason: 'fraudulent' },
    });
  });

  it('reads the dispute fee from the dispute balance transactions, counting only the dispute currency', () => {
    const balance_transactions = [
      { type: 'adjustment', amount: -5000, fee: 1500, currency: 'usd' },
      { type: 'adjustment', amount: -100, fee: 200, currency: 'eur' },
    ];
    expect(parse('charge.dispute.created', { ...dispute, status: 'needs_response', balance_transactions })).toMatchObject({ data: { fee: 1500 } });
  });

  it('reports no dispute fee when Stripe attaches none', () => {
    const e = parse('charge.dispute.created', { ...dispute, status: 'needs_response', balance_transactions: [] });
    expect(e.data).not.toHaveProperty('fee');
  });

  it.each([
    ['won', 'dispute.won'],
    ['lost', 'dispute.lost'],
  ])('maps a closed dispute with status %s to %s', (status, type) => {
    expect(parse('charge.dispute.closed', { ...dispute, status })).toMatchObject({ type, data: { disputeRef: 'dp_1', providerRef: 'pi_1', amount: 5000 } });
  });

  it('does not treat a warning_* inquiry as a dispute: no funds were withdrawn, so nothing must hit the ledger', () => {
    expect(parse('charge.dispute.created', { ...dispute, status: 'warning_needs_response' }).type).toBe('dispute.inquiry');
    expect(parse('charge.dispute.closed', { ...dispute, status: 'warning_closed' }).type).toBe('dispute.inquiry');
  });

  it('maps a failed payment intent to payment.failed with the reason', () => {
    expect(
      parse('payment_intent.payment_failed', { id: 'pi_1', metadata: { payment_id: 'pay-1' }, last_payment_error: { message: 'Card expired' } }),
    ).toMatchObject({ type: 'payment.failed', data: { providerRef: 'pi_1', paymentId: 'pay-1', reason: 'Card expired' } });
  });
});

describe('StripeProvider trace propagation', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

  it('continues the caller\'s trace on outgoing calls, with a new span id', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pi_1' }));
    const ctx = newContext({ traceparent: `00-${TRACE}-00f067aa0ba902b7-01` });
    await runWithContext(ctx, () => providerFor(fake!.url).authorize(authorizeReq));
    expect(fake.requests[0].headers['traceparent']).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
  });

  it('sends no traceparent when there is no request context (background jobs)', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pi_1' }));
    await providerFor(fake.url).authorize(authorizeReq);
    expect(fake.requests[0].headers['traceparent']).toBeUndefined();
  });
});

describe('StripeProvider error classification', () => {
  const fails = (status: number, error: Record<string, unknown>) => async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, status, { error }));
    return providerFor(fake.url).authorize(authorizeReq);
  };

  it('treats a declined card (402 card_error) as a definitive rejection carrying Stripe\'s code and message', async () => {
    const err = await fails(402, { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' })().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect(err).toMatchObject({ code: 'card_declined', message: 'Your card was declined.' });
  });

  it('treats an invalid request (400 invalid_request_error) as definitive', async () => {
    await expect(fails(400, { type: 'invalid_request_error', code: 'amount_too_small', message: 'Amount too small' })()).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it.each([
    [500, { type: 'api_error', message: 'Stripe is having a bad day' }],
    [429, { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests' }],
    [401, { type: 'invalid_request_error', message: 'Invalid API Key provided' }],
    [403, { type: 'invalid_request_error', message: 'Forbidden' }],
  ])('does NOT treat %s as a rejection: outcome unknown or operational, so it must be retried, not shown as a decline', async (status, error) => {
    const err = await fails(status, error)().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderRejectedError);
  });
});

describe('StripeProvider capture, refund and void', () => {
  it('sends the caller\'s idempotency key on capture and refund, so a re-execution is deduplicated by Stripe', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'x_1', latest_charge: 'ch_1' }));
    const provider = providerFor(fake.url);
    await provider.capture({ paymentId: 'p1', providerRef: 'pi_1', amount: 1000, currency: 'USD', idempotencyKey: 'capture:p1:1' });
    await provider.refund({ refundId: 'r1', providerRef: 'pi_1', amount: 500, currency: 'USD', idempotencyKey: 'refund:r1' });
    expect(fake.requests.map((r) => [r.url, r.headers['idempotency-key']])).toEqual([
      ['/payment_intents/pi_1/capture', 'capture:p1:1'],
      ['/refunds', 'refund:r1'],
    ]);
  });

  it('cancels the PaymentIntent to void an authorization', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pi_1', status: 'canceled' }));
    await providerFor(fake.url).void({ paymentId: 'p1', providerRef: 'pi_1', idempotencyKey: 'void:p1' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'POST', url: '/payment_intents/pi_1/cancel' });
    expect(fake.requests[0].headers['idempotency-key']).toBe('void:p1');
  });
});

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
    await expect(providerFor(fake.url, SHORT).authorize(authorizeReq)).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('also times out when the response body stalls after the headers', async () => {
    fake = await startFakeHttp((_req, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":'); // never finishes the JSON
    });
    await expect(providerFor(fake.url, SHORT).authorize(authorizeReq)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('still returns normally when the server answers in time', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { id: 'pi_1' }));
    await expect(providerFor(fake.url).authorize(authorizeReq)).resolves.toEqual({ providerRef: 'pi_1' });
  });
});
