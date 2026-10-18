import { describeE2E, startApp, TestApp } from './helpers';

describeE2E('schema indexes (e2e, real Postgres)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  it('records the index migration as applied', async () => {
    const r = await t.db.query("SELECT 1 FROM schema_migrations WHERE name = '002_indexes.sql'");
    expect(r.rowCount).toBe(1);
  });

  /** Plans a query with sequential scans disabled, so an index is used whenever one is usable at all. */
  const usesIndex = async (sql: string, index: string) => {
    const plan = await t.db.tx(async (c) => {
      await c.query('SET LOCAL enable_seqscan = off');
      const r = await c.query(`EXPLAIN ${sql}`);
      return r.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain(index);
  };

  it('serves the dead-letter listing and counts from an index on webhook_events(status, received_at)', async () => {
    await usesIndex(
      `SELECT provider, event_id FROM webhook_events WHERE status = 'dead' ORDER BY received_at DESC LIMIT 200`,
      'webhook_events_status_idx',
    );
    await usesIndex(`SELECT count(*) FROM webhook_events WHERE status = 'dead'`, 'webhook_events_status_idx');
  });

  it('serves status lookups on payments', async () => {
    await usesIndex(`SELECT id FROM payments WHERE status = 'authorized'`, 'payments_status_idx');
  });

  it('serves the retention job\'s batched deletes from indexes', async () => {
    await usesIndex(
      `SELECT scope, key FROM idempotency_keys WHERE created_at < now() - interval '7 days' ORDER BY created_at LIMIT 5000`,
      'idempotency_keys_created_idx',
    );
    await usesIndex(
      `SELECT provider, event_id FROM webhook_events WHERE status = 'processed' AND processed_at < now() - interval '30 days' ORDER BY processed_at LIMIT 5000`,
      'webhook_events_processed_idx',
    );
  });

  it('serves "pending payouts not touched since X" scans from payouts(status, updated_at)', async () => {
    await usesIndex(
      `SELECT id FROM payouts WHERE status = 'pending' AND updated_at < now() - interval '1 hour'`,
      'payouts_status_updated_idx',
    );
  });
});
