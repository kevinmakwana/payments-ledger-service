import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

describeE2E('retention (e2e, real Postgres)', () => {
  let t: TestApp;
  beforeAll(async () => {
    // TTL 24h, retention 30 days (explicit, so the suite does not depend on defaults)
    t = await startApp({ IDEMPOTENCY_KEY_TTL_HOURS: '24', WEBHOOK_RETENTION_DAYS: '30', RECONCILIATION_ITEM_RETENTION_DAYS: '90' });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
    delete process.env.IDEMPOTENCY_KEY_TTL_HOURS;
    delete process.env.WEBHOOK_RETENTION_DAYS;
    delete process.env.RECONCILIATION_ITEM_RETENTION_DAYS;
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

  it('deletes only OLD CLOSED reconciliation items; open ones are kept however old', async () => {
    const item = (ref: string, status: string, age: string) =>
      t.db.query(
        `INSERT INTO reconciliation_items (provider, kind, ref, date, type, currency, status, first_seen_at, resolved_at)
         VALUES ('simulated', 'charge', $1, current_date, 'missing_in_ledger', 'USD', $2,
                 now() - interval '${age}', CASE WHEN $2 = 'open' THEN NULL ELSE now() - interval '${age}' END)`,
        [ref, status],
      );
    await item('old-resolved', 'resolved', '200 days');
    await item('old-ignored', 'ignored', '120 days');
    await item('recent-resolved', 'resolved', '10 days');
    await item('old-open', 'open', '400 days');
    expect((await purge()).reconciliationItems).toBe(2);
    const refs = (await t.db.query('SELECT ref FROM reconciliation_items ORDER BY ref')).rows.map((r) => r.ref);
    expect(refs).toEqual(['old-open', 'recent-resolved']);
  });

  it('works through large backlogs in batches', async () => {
    for (let i = 0; i < 7; i++) await idemKey(`bulk-${i}`, '10 days');
    expect((await purge(2)).idempotencyKeys).toBe(7);
    expect(await keys()).toEqual([]);
  });

  it('does nothing on a clean database', async () => {
    expect(await purge()).toEqual({ idempotencyKeys: 0, webhookEvents: 0, reconciliationItems: 0 });
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
