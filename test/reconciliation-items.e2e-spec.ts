import { ReconciliationProcessor } from '../src/reconciliation/reconciliation.processor';
import { FakeHttp, respondJson, startFakeHttp } from './fake-http';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';
const asAdmin = { authorization: `Bearer ${ADMIN}` };
const asClient = { authorization: `Bearer ${CLIENT}` };

describeE2E('reconciliation items (e2e)', () => {
  let t: TestApp;
  let hook: FakeHttp;
  const today = () => new Date().toISOString().slice(0, 10);
  const alerts = (kind?: string) => hook.requests.map((r) => JSON.parse(r.body)).filter((a) => kind === undefined || a.kind === kind);
  const reconcile = async () => (await t.call('GET', `/reports/reconciliation?date=${today()}`, undefined, asAdmin)).body;
  const nightly = (data: Record<string, unknown> = { date: today() }) => t.app.get(ReconciliationProcessor).process({ data } as never);
  const items = async (qs = '') => (await t.call('GET', `/reports/reconciliation/items${qs}`, undefined, asAdmin)).body;
  const sale = async (sellerId: string, amount = 10000) =>
    (await t.call('POST', '/payments', newPayment({ sellerId, amount, capture: true }), { 'idempotency-key': key(), ...asAdmin })).body;

  beforeAll(async () => {
    hook = await startFakeHttp((_req, res) => respondJson(res, 200, { ok: true }));
    t = await startApp({ API_KEYS: `${ADMIN}:admin,${CLIENT}:client`, ALERT_WEBHOOK_URL: hook.url, RECONCILIATION_STALE_DAYS: '3' });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
    hook.requests.length = 0;
  });
  afterAll(async () => {
    await t.close();
    await hook.close();
    for (const k of ['API_KEYS', 'ALERT_WEBHOOK_URL', 'RECONCILIATION_STALE_DAYS']) delete process.env[k];
  });

  describe('tracking', () => {
    it('records each mismatch once as an open item, and a re-run neither duplicates it nor calls it new', async () => {
      const a = await sale('items_a', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9999 } });
      const first = await reconcile();
      expect(first.summary).toMatchObject({ mismatches: 1, open: 1, new: 1, autoResolved: 0 });
      expect(first.mismatches[0]).toMatchObject({ type: 'amount_mismatch', status: 'open', isNew: true, itemId: expect.any(String) });

      const second = await reconcile();
      expect(second.summary).toMatchObject({ mismatches: 1, open: 1, new: 0 });
      expect(second.mismatches[0].itemId).toBe(first.mismatches[0].itemId);

      const list = await items();
      expect(list.data).toHaveLength(1);
      expect(list.data[0]).toMatchObject({
        id: first.mismatches[0].itemId, provider: 'simulated', kind: 'charge', ref: a.providerRef, type: 'amount_mismatch',
        providerAmount: 9999, ledgerAmount: 10000, currency: 'USD', status: 'open', date: today(),
      });
    });

    it('closes an item by itself once a later run finds the transaction matched (e.g. a late webhook caught up)', async () => {
      const a = await sale('items_late', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9000 } });
      const first = await reconcile();
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 10000 } }); // the books now agree
      const after = await reconcile();
      expect(after.summary).toMatchObject({ mismatches: 0, open: 0, autoResolved: 1 });
      const item = (await t.call('GET', `/reports/reconciliation/items/${first.mismatches[0].itemId}`, undefined, asAdmin)).body;
      expect(item).toMatchObject({ status: 'resolved', resolution: 'auto_matched', resolvedBy: 'reconciliation' });
      expect(item.resolvedAt).toBeTruthy();
    });

    it('reopens a resolved item as NEW if the same discrepancy comes back', async () => {
      const a = await sale('items_back', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9000 } });
      const first = await reconcile();
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 10000 } });
      await reconcile();
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9000 } });
      const again = await reconcile();
      expect(again.summary).toMatchObject({ open: 1, new: 1 });
      expect(again.mismatches[0].itemId).toBe(first.mismatches[0].itemId);
      expect((await items('?status=open')).data).toHaveLength(1);
      expect((await items('?status=resolved')).data).toHaveLength(0);
    });

    it('refreshes an open item when the discrepancy changes, without calling it new', async () => {
      const a = await sale('items_change', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9000 } });
      await reconcile();
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 8000 } });
      const r = await reconcile();
      expect(r.summary).toMatchObject({ open: 1, new: 0 });
      expect((await items()).data[0]).toMatchObject({ providerAmount: 8000 });
    });

    it('tracks provider-only and ledger-only transactions too', async () => {
      const b = await sale('items_b', 20000);
      await t.sim.tamper({ remove: b.providerRef });
      await t.sim.tamper({ add: { id: 'sim_ch_ghost', type: 'charge', amount: 777, currency: 'USD', createdAt: new Date().toISOString() } });
      await reconcile();
      const types = (await items()).data.map((i: { type: string }) => i.type).sort();
      expect(types).toEqual(['missing_at_provider', 'missing_in_ledger']);
    });
  });

  describe('operator workflow', () => {
    const openOne = async () => {
      const a = await sale(`wf_${Math.random().toString(36).slice(2, 8)}`, 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9999 } });
      return { sale: a, report: await reconcile() };
    };

    it('ignores an item with a note, keeps it ignored while unchanged, and stops alerting about it', async () => {
      const { report } = await openOne();
      const id = report.mismatches[0].itemId;
      expect((await t.call('POST', `/reports/reconciliation/items/${id}/ignore`, {}, asAdmin)).status).toBe(400); // a note is required
      expect((await t.call('POST', `/reports/reconciliation/items/${id}/ignore`, { note: 'ab' }, asAdmin)).status).toBe(400);
      const ignored = await t.call('POST', `/reports/reconciliation/items/${id}/ignore`, { note: 'Known provider rounding, ticket #42' }, asAdmin);
      expect(ignored.status).toBe(200);
      expect(ignored.body).toMatchObject({ status: 'ignored', resolution: 'ignored', note: 'Known provider rounding, ticket #42', resolvedBy: expect.stringMatching(/^env:/) });

      hook.requests.length = 0;
      await nightly();
      expect(alerts('reconciliation_mismatch')).toHaveLength(0); // ignored: nobody gets paged
      const r = await reconcile();
      expect(r.summary).toMatchObject({ mismatches: 1, open: 0, new: 0 });
      expect(r.mismatches[0]).toMatchObject({ status: 'ignored' });
    });

    it('is idempotent to ignore twice, and an ignored item reopens by hand', async () => {
      const { report } = await openOne();
      const id = report.mismatches[0].itemId;
      const post = (path: string, body: unknown = {}) => t.call('POST', `/reports/reconciliation/items/${id}/${path}`, body, asAdmin);
      expect((await post('ignore', { note: 'first' })).status).toBe(200);
      const again = await post('ignore', { note: 'second' });
      expect(again.status).toBe(200);
      expect(again.body.note).toBe('first'); // the original record is not overwritten
      const reopened = await post('reopen');
      expect(reopened.body).toMatchObject({ status: 'open', resolution: null, resolvedAt: null });
      expect((await post('reopen')).status).toBe(200); // already open: no-op
      expect((await items('?status=open')).data).toHaveLength(1);
    });

    it('un-ignores an item whose discrepancy changed: an earlier "this is fine" does not cover a different problem', async () => {
      const { sale: s, report } = await openOne();
      await t.call('POST', `/reports/reconciliation/items/${report.mismatches[0].itemId}/ignore`, { note: 'expected' }, asAdmin);
      await t.sim.tamper({ setAmount: { id: s.providerRef, amount: 5000 } }); // now off by much more
      const r = await reconcile();
      expect(r.summary).toMatchObject({ open: 1, new: 1 });
      expect((await t.call('GET', `/reports/reconciliation/items/${report.mismatches[0].itemId}`, undefined, asAdmin)).body).toMatchObject({ status: 'open', note: 'expected' });
    });

    it('refuses to ignore or reopen a resolved item', async () => {
      const { sale: s, report } = await openOne();
      const id = report.mismatches[0].itemId;
      await t.sim.tamper({ setAmount: { id: s.providerRef, amount: 10000 } });
      await reconcile();
      const ig = await t.call('POST', `/reports/reconciliation/items/${id}/ignore`, { note: 'too late' }, asAdmin);
      expect(ig.status).toBe(409);
      expect(ig.body.code).toBe('item_resolved');
      expect((await t.call('POST', `/reports/reconciliation/items/${id}/reopen`, {}, asAdmin)).status).toBe(409);
    });

    it('404s for unknown items and 400s for malformed ids', async () => {
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect((await t.call('GET', `/reports/reconciliation/items/${unknown}`, undefined, asAdmin)).status).toBe(404);
      expect((await t.call('POST', `/reports/reconciliation/items/${unknown}/ignore`, { note: 'whatever' }, asAdmin)).status).toBe(404);
      expect((await t.call('POST', `/reports/reconciliation/items/${unknown}/reopen`, {}, asAdmin)).status).toBe(404);
      expect((await t.call('GET', '/reports/reconciliation/items/nope', undefined, asAdmin)).status).toBe(400);
    });

    it('is admin only', async () => {
      const { report } = await openOne();
      const id = report.mismatches[0].itemId;
      expect((await t.call('GET', '/reports/reconciliation/items', undefined, asClient)).status).toBe(403);
      expect((await t.call('POST', `/reports/reconciliation/items/${id}/ignore`, { note: 'sneaky' }, asClient)).status).toBe(403);
      expect((await t.call('GET', '/reports/reconciliation/items')).status).toBe(401);
    });
  });

  describe('listing', () => {
    it('filters by status, type and date, and paginates newest first', async () => {
      for (const n of ['p', 'q', 'r']) {
        const s = await sale(`list_${n}`, 1000);
        await t.sim.tamper({ setAmount: { id: s.providerRef, amount: 1 } });
      }
      await reconcile();
      const first = await items('?limit=2');
      expect(first.data).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();
      const second = await items(`?limit=2&cursor=${first.nextCursor}`);
      expect(second.data).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.data, ...second.data].map((i: { id: string }) => i.id)).size).toBe(3);
      expect((await items('?type=missing_in_ledger')).data).toHaveLength(0);
      expect((await items('?type=amount_mismatch')).data).toHaveLength(3);
      expect((await items(`?date=${today()}&status=open`)).data).toHaveLength(3);
      expect((await items('?date=2001-01-01')).data).toHaveLength(0);
      expect((await t.call('GET', '/reports/reconciliation/items?status=bogus', undefined, asAdmin)).status).toBe(400);
      expect((await t.call('GET', '/reports/reconciliation/items?cursor=garbage', undefined, asAdmin)).status).toBe(400);
    });
  });

  describe('nightly job and alerts', () => {
    it('alerts once for a new mismatch, not again for the same open item on the next night', async () => {
      const a = await sale('night_a', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 9999 } });
      await nightly();
      expect(alerts('reconciliation_mismatch')).toHaveLength(1);
      expect(alerts('reconciliation_mismatch')[0].details).toMatchObject({ new: 1, open: 1, sample: [expect.objectContaining({ isNew: true })] });
      await nightly();
      expect(alerts('reconciliation_mismatch')).toHaveLength(1);
    });

    it('re-checks a lookback window of days when run without a date, covering every available provider', async () => {
      const totals = (await nightly({})) as { days: number };
      expect(totals.days).toBe(3); // RECONCILIATION_LOOKBACK_DAYS default, one provider (the simulator) configured
    });

    it('alerts every night about items left open too long, but not about ignored ones', async () => {
      const a = await sale('stale_a', 10000);
      const b = await sale('stale_b', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 1 } });
      await t.sim.tamper({ setAmount: { id: b.providerRef, amount: 2 } });
      const r = await reconcile();
      await t.db.query("UPDATE reconciliation_items SET first_seen_at = now() - interval '5 days'");
      await nightly();
      expect(alerts('reconciliation_item_stale')).toHaveLength(1);
      expect(alerts('reconciliation_item_stale')[0]).toMatchObject({ severity: 'critical', details: { count: 2, staleAfterDays: 3 } });
      await t.call('POST', `/reports/reconciliation/items/${r.mismatches[0].itemId}/ignore`, { note: 'accepted' }, asAdmin);
      hook.requests.length = 0;
      await nightly();
      expect(alerts('reconciliation_item_stale')[0].details.count).toBe(1);
    });

    it('does not raise a stale alert for fresh items', async () => {
      const a = await sale('fresh_a', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 1 } });
      await nightly();
      expect(alerts('reconciliation_item_stale')).toHaveLength(0);
    });
  });

  describe('metrics', () => {
    it('exposes tracked items by status and the age of the oldest open one', async () => {
      const a = await sale('metrics_a', 10000);
      await t.sim.tamper({ setAmount: { id: a.providerRef, amount: 1 } });
      await reconcile();
      await t.db.query("UPDATE reconciliation_items SET first_seen_at = now() - interval '2 hours'");
      const text = await (await fetch(`${t.url}/metrics`, { headers: asAdmin })).text();
      expect(text).toMatch(/reconciliation_items\{status="open"\} 1/);
      expect(text).toMatch(/reconciliation_items\{status="resolved"\} 0/);
      const age = Number(/reconciliation_oldest_open_item_age_seconds (\d+)/.exec(text)![1]);
      expect(age).toBeGreaterThanOrEqual(7200);
    });
  });
});
