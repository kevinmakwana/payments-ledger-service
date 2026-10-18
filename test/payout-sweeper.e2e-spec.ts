import { PayoutsService } from '../src/payouts/payouts.service';
import { FakeHttp, respondJson, startFakeHttp } from './fake-http';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

describeE2E('payout sweeper (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  let hook: FakeHttp;
  const in3Days = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
  const alerts = (kind: string) => hook.requests.map((r) => JSON.parse(r.body)).filter((a) => a.kind === kind);
  const payouts = () => t.app.get(PayoutsService);

  beforeAll(async () => {
    hook = await startFakeHttp((_req, res) => respondJson(res, 200, { ok: true }));
    t = await startApp({ ALERT_WEBHOOK_URL: hook.url });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
    hook.requests.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await t.close();
    await hook.close();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  const sale = async (sellerId: string) =>
    (await t.call('POST', '/payments', newPayment({ sellerId, amount: 10000, capture: true }), { 'idempotency-key': key() })).body;
  const backdate = (id: string, interval = '1 hour') => t.db.query(`UPDATE payouts SET updated_at = now() - interval '${interval}' WHERE id = $1`, [id]);
  const status = async (id: string) => (await t.db.query('SELECT status FROM payouts WHERE id = $1', [id])).rows[0].status;

  /** Creates a payout whose dispatch job was never enqueued: the process "crashed" after the batch committed. */
  const orphanedPayout = async (sellerId: string) => {
    await sale(sellerId);
    const enqueue = jest.spyOn(PayoutsService.prototype, 'enqueueDispatch').mockRejectedValueOnce(new Error('redis down'));
    const run = await t.call('POST', '/payouts/run', { asOf: in3Days() });
    expect(run.status).toBe(500);
    enqueue.mockRestore();
    const row = (await t.db.query("SELECT id, provider_ref FROM payouts WHERE seller_id = $1", [sellerId])).rows[0];
    expect(row.provider_ref).toBeNull();
    return row.id as string;
  };

  it('re-dispatches a pending payout that never got a dispatch job, and it gets paid', async () => {
    const id = await orphanedPayout('sweep_orphan');
    await backdate(id);
    expect((await payouts().sweep()).redispatched).toEqual([id]);
    await waitFor(async () => (await status(id)) === 'paid', 15000, 'swept payout paid');
  });

  it('leaves a fresh pending payout alone (its normal dispatch may still be in flight)', async () => {
    const id = await orphanedPayout('sweep_fresh');
    expect(await payouts().sweep()).toEqual({ redispatched: [], awaitingProvider: [] });
    expect(await status(id)).toBe('pending');
  });

  it('claims what it re-dispatches, so a second sweep does not enqueue it again', async () => {
    const id = await orphanedPayout('sweep_twice');
    await backdate(id);
    const enqueue = jest.spyOn(PayoutsService.prototype, 'enqueueDispatch').mockResolvedValue(undefined as never);
    expect((await payouts().sweep()).redispatched).toEqual([id]);
    expect((await payouts().sweep()).redispatched).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('alerts, without re-dispatching, for a payout the provider accepted but never reported on', async () => {
    const { rows } = await t.db.query(
      `INSERT INTO payouts (seller_id, amount, currency, status, provider, provider_ref, attempts, updated_at)
       VALUES ('sweep_silent', 5000, 'USD', 'pending', 'simulated', 'sim_po_silent', 1, now() - interval '2 days') RETURNING id`,
    );
    const id = rows[0].id as string;
    const enqueue = jest.spyOn(PayoutsService.prototype, 'enqueueDispatch');
    expect(await payouts().sweep()).toEqual({ redispatched: [], awaitingProvider: [id] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(alerts('payout_awaiting_provider')).toHaveLength(1);
    expect(alerts('payout_awaiting_provider')[0]).toMatchObject({
      severity: 'critical',
      details: { payoutIds: [id] },
    });
  });

  it('does not alert for a payout the provider accepted recently', async () => {
    await t.db.query(
      `INSERT INTO payouts (seller_id, amount, currency, status, provider, provider_ref, attempts)
       VALUES ('sweep_recent', 5000, 'USD', 'pending', 'simulated', 'sim_po_recent', 1)`,
    );
    expect((await payouts().sweep()).awaitingProvider).toEqual([]);
    expect(alerts('payout_awaiting_provider')).toHaveLength(0);
  });
});
