import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

describeE2E('retention (e2e, real Postgres)', () => {
  let t: TestApp;
  beforeAll(async () => {
    // TTL 24h, retention 30 days (explicit, so the suite does not depend on defaults)
    t = await startApp({ IDEMPOTENCY_KEY_TTL_HOURS: '24', WEBHOOK_RETENTION_DAYS: '30' });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
    delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
    delete process.env.WEBHOOK_RETENTION_DAYS;
  });

  const purge = (batchSize?: number) => t.app.get(MaintenanceService).purge(batchSize);
  const idemKey = (k: string, age: string) =>
    t.db.query(`INSERT INTO idempotency_keys (scope, key, request_hash, created_at) VALUES ('test', $1, 'h', now() - interval '${age}')`, [k]);
  const event = (id: string, status: string, age: string) =>
    t.db.query(
      `INSERT INTO webhook_events (provider, event_id, type, payload, status, received_at, processed_at)
       VALUES ('simulated', $1, 'x', '{}', $2, now() - interval '${age}', CASE WHEN $2 = 'processed' THEN now() - interval '${age}' END)`,
      [id, status],
    );
  const keys = async () => (await t.db.query('SELECT key FROM idempotency_keys ORDER BY key')).rows.map((r) => r.key);
  const events = async () => (await t.db.query('SELECT event_id FROM webhook_events ORDER BY event_id')).rows.map((r) => r.event_id);

  it('deletes idempotency keys past the TTL and keeps recent ones', async () => {
    await idemKey('old-1', '3 days');
    await idemKey('old-2', '25 hours');
    await idemKey('fresh', '2 hours');
    expect((await purge()).idempotencyKeys).toBe(2);
    expect(await keys()).toEqual(['fresh']);
  });

  it('deletes only OLD PROCESSED webhook events; received and dead-lettered ones are kept however old', async () => {
    await event('old-processed', 'processed', '60 days');
    await event('recent-processed', 'processed', '5 days');
    await event('old-dead', 'dead', '90 days');
    await event('old-received', 'received', '90 days');
    expect((await purge()).webhookEvents).toBe(1);
    expect(await events()).toEqual(['old-dead', 'old-received', 'recent-processed']);
  });

  it('works through large backlogs in batches', async () => {
    for (let i = 0; i < 7; i++) await idemKey(`bulk-${i}`, '10 days');
    expect((await purge(2)).idempotencyKeys).toBe(7);
    expect(await keys()).toEqual([]);
  });

  it('does nothing on a clean database', async () => {
    expect(await purge()).toEqual({ idempotencyKeys: 0, webhookEvents: 0 });
  });

  it('does not remove the key of a request that is still replaying (recent real payment)', async () => {
    const k = key();
    const first = await t.call('POST', '/payments', newPayment({ sellerId: 'retain', capture: true }), { 'idempotency-key': k });
    await purge();
    const replay = await t.call('POST', '/payments', newPayment({ sellerId: 'retain', capture: true }), { 'idempotency-key': k });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
  });
});
