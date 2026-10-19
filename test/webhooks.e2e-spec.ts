import { randomUUID } from 'crypto';
import { WebhookEvent } from '../src/providers/provider.interface';
import { signTimestamped } from '../src/providers/signature';
import { describeE2E, evt, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

const SECRET = 'whsec_simulated_dev';

describeE2E('webhooks (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ SIMULATED_WEBHOOK_SECRET: SECRET });
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  const post = (event: WebhookEvent | string, header?: string, ts = Math.floor(Date.now() / 1000)) => {
    const body = typeof event === 'string' ? event : JSON.stringify(event);
    return fetch(`${t.url}/webhooks/simulated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(header === '' ? {} : { 'x-signature': header ?? signTimestamped(SECRET, body, ts) }) },
      body,
    });
  };
  const row = async (id: string) => (await t.db.query('SELECT * FROM webhook_events WHERE event_id = $1', [id])).rows[0];

  it('rejects missing and forged signatures with 401, and stores nothing', async () => {
    const e = evt('payment.captured', { paymentId: randomUUID() });
    expect((await post(e, '')).status).toBe(401);
    expect((await post(e, signTimestamped('wrong-secret', JSON.stringify(e), Math.floor(Date.now() / 1000)))).status).toBe(401);
    expect(await row(e.id)).toBeUndefined();
  });

  it('rejects a tampered body even with a once-valid signature', async () => {
    const e = evt('payout.paid', { payoutId: randomUUID() });
    const sig = signTimestamped(SECRET, JSON.stringify(e), Math.floor(Date.now() / 1000));
    const tampered = JSON.stringify({ ...e, type: 'payout.failed' });
    expect((await post(tampered, sig)).status).toBe(401);
  });

  it('rejects stale timestamps (replay protection) with 400', async () => {
    const e = evt('payment.captured', { paymentId: randomUUID() });
    const r = await post(e, undefined, Math.floor(Date.now() / 1000) - 3600);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('stale_timestamp');
    expect(await row(e.id)).toBeUndefined();
  });

  it('rejects an unknown provider', async () => {
    const r = await fetch(`${t.url}/webhooks/nope`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(400);
  });

  it('accepts a valid event, processes it asynchronously and dedupes redeliveries by event id', async () => {
    const p = (await t.call('POST', '/payments', newPayment({ capture: true }), { 'idempotency-key': key() })).body;
    // Wait for the simulator's own signed webhook for this capture to be processed.
    await waitFor(async () => (await t.call('GET', `/payments/${p.id}`)).body.captureConfirmedByProvider, 10000, 'capture confirmation');

    const e = evt('payment.captured', { paymentId: p.id, providerRef: p.providerRef, amount: p.amount });
    const first = await post(e);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ received: true, duplicate: false });
    await waitFor(async () => (await row(e.id))?.status === 'processed', 10000, 'event processed');

    const second = await post(e); // same event id, fresh signature
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    const count = await t.db.query('SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1', [e.id]);
    expect(count.rows[0].n).toBe(1);
    expect((await row(e.id)).attempts).toBe(1); // handled once, not twice
  });

  it('retries with backoff, then dead-letters an event that keeps failing; dead letters can be re-driven', async () => {
    const missing = randomUUID(); // payment does not exist yet -> handler throws a retryable error
    const e = evt('payment.captured', { paymentId: missing });
    expect((await post(e)).status).toBe(202);

    await waitFor(async () => (await row(e.id))?.status === 'dead', 15000, 'dead-lettering');
    const dead = await row(e.id);
    expect(dead.attempts).toBe(3); // WEBHOOK_MAX_ATTEMPTS
    expect(dead.last_error).toContain('not captured in our DB yet');
    const listed = (await t.call('GET', '/webhooks/dead-letters')).body.data;
    expect(listed.map((d: { eventId: string }) => d.eventId)).toContain(e.id);

    // "Fix" the cause: the payment now exists as captured, then re-drive the dead letter.
    await t.db.query(
      `INSERT INTO payments (id, buyer_id, seller_id, amount, fee_amount, currency, status, provider)
       VALUES ($1,'b','s',100,10,'USD','captured','simulated')`,
      [missing],
    );
    const retry = await t.call('POST', `/webhooks/dead-letters/simulated/${e.id}/retry`);
    expect(retry.status).toBe(202);
    await waitFor(async () => (await row(e.id))?.status === 'processed', 15000, 're-driven event processed');
  });

  it('acknowledges and stores unknown event types without acting on them', async () => {
    const e = evt('customer.updated', {});
    expect((await post(e)).status).toBe(202);
    await waitFor(async () => (await row(e.id))?.status === 'processed', 10000, 'unknown event processed');
  });
});
