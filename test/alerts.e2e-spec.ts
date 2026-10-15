import { randomUUID } from 'crypto';
import { MonitorService } from '../src/monitoring/monitor.service';
import { ReconciliationProcessor } from '../src/reconciliation/reconciliation.processor';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { FakeHttp, respondJson, startFakeHttp } from './fake-http';
import { describeE2E, evt, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

describeE2E('operational alerts (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  let hook: FakeHttp;
  const today = () => new Date().toISOString().slice(0, 10);
  const alerts = (kind?: string) =>
    hook.requests.map((r) => JSON.parse(r.body)).filter((a) => kind === undefined || a.kind === kind);

  beforeAll(async () => {
    hook = await startFakeHttp((_req, res) => respondJson(res, 200, { ok: true }));
    t = await startApp({ ALERT_WEBHOOK_URL: hook.url, ALERT_DLQ_THRESHOLD: '1' });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
    hook.requests.length = 0;
  });
  afterAll(async () => {
    await t.close();
    await hook.close();
    delete process.env.ALERT_WEBHOOK_URL; // env is shared by later suites in the same process
    delete process.env.ALERT_DLQ_THRESHOLD;
  });

  const sale = async (sellerId: string, amount = 10000) =>
    (await t.call('POST', '/payments', newPayment({ sellerId, amount, capture: true }), { 'idempotency-key': key() })).body;
  const reconcileNightly = (date: string) => t.app.get(ReconciliationProcessor).process({ data: { date } } as never);

  describe('reconciliation', () => {
    it('raises a critical alert listing the mismatches found by the nightly job', async () => {
      const p = await sale('recon_alert');
      await t.sim.tamper({ setAmount: { id: p.providerRef, amount: 9999 } });
      await reconcileNightly(today());
      expect(alerts('reconciliation_mismatch')).toHaveLength(1);
      expect(alerts('reconciliation_mismatch')[0]).toMatchObject({
        severity: 'critical',
        details: { provider: 'simulated', date: today(), mismatches: 1 },
      });
    });

    it('stays silent when provider and ledger agree', async () => {
      await sale('recon_quiet');
      await reconcileNightly(today());
      expect(alerts()).toHaveLength(0);
    });
  });

  describe('webhook dead letters', () => {
    it('alerts when an event exhausts its retries and is dead-lettered', async () => {
      const missing = randomUUID();
      const e = evt('payment.captured', { paymentId: missing }); // payment never exists -> retries exhausted
      await t.app.get(WebhooksService).receive('simulated', e);
      await waitFor(async () => alerts('webhook_dead_lettered').length > 0, 15000, 'dead-letter alert');
      expect(alerts('webhook_dead_lettered')[0]).toMatchObject({
        severity: 'warning',
        details: { provider: 'simulated', eventId: e.id },
      });
    });
  });

  describe('monitor job', () => {
    const monitor = () => t.app.get(MonitorService).run();

    it('raises nothing on a healthy system', async () => {
      await sale('monitor_ok');
      expect(await monitor()).toEqual([]);
      expect(alerts()).toHaveLength(0);
    });

    it('alerts when dead-lettered events reach the threshold', async () => {
      await t.db.query(
        `INSERT INTO webhook_events (provider, event_id, type, payload, status) VALUES ('simulated','evt_dead_1','x','{}','dead')`,
      );
      const raised = await monitor();
      expect(raised.map((a) => a.kind)).toEqual(['webhook_dlq_depth']);
      expect(alerts('webhook_dlq_depth')[0]).toMatchObject({ severity: 'warning', details: { deadLetters: 1, threshold: 1 } });
    });

    it('alerts critically when the cached balances drift from the postings', async () => {
      await sale('monitor_drift');
      await t.db.query(`UPDATE account_balances SET balance = balance + 1 WHERE account_id = (SELECT id FROM accounts WHERE code = 'seller:monitor_drift:USD')`);
      const raised = await monitor();
      expect(raised.map((a) => a.kind)).toEqual(['ledger_drift']);
      expect(alerts('ledger_drift')[0]).toMatchObject({ severity: 'critical', details: { inconsistentAccounts: ['seller:monitor_drift:USD'] } });
    });
  });
});
