import { describeE2E, evt, key, newPayment, resetDb, startApp, TestApp, waitFor } from './helpers';

const ADMIN = 'sk_admin_0123456789abcdef';
const CLIENT = 'sk_client_0123456789abcdef';
const admin = { authorization: `Bearer ${ADMIN}` };
const client = { authorization: `Bearer ${CLIENT}` };

describeE2E('list and read APIs (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  const in3Days = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

  beforeAll(async () => {
    t = await startApp({ API_KEYS: `${ADMIN}:admin,${CLIENT}:client` });
  });
  beforeEach(async () => {
    await t.drain();
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
    delete process.env.API_KEYS;
  });

  const get = (path: string, headers = admin) => t.call('GET', path, undefined, headers);
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => t.call('POST', path, body, { ...admin, ...extra });
  const sale = async (sellerId: string, over: Record<string, unknown> = {}) =>
    (await post('/payments', newPayment({ sellerId, capture: true, ...over }), { 'idempotency-key': key() })).body;
  /** Follows nextCursor to the end and returns every item in order. */
  const pageThrough = async (path: string, limit: number) => {
    const items: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const res: { status: number; body: { data: any[]; nextCursor: string | null } } = await get(`${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      items.push(...res.body.data);
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    return { items, pages };
  };

  describe('GET /payments', () => {
    it('pages newest-first through every payment exactly once', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await sale(`list_${i}`)).id);
      const { items, pages } = await pageThrough('/payments', 3);
      expect(pages).toBe(3);
      expect(items.map((p) => p.id)).toEqual([...ids].reverse());
      expect(new Set(items.map((p) => p.id)).size).toBe(7);
    });

    it('stays consistent while new payments arrive between pages (keyset, not offset)', async () => {
      for (let i = 0; i < 5; i++) await sale(`stable_${i}`);
      const first = await get('/payments?limit=3');
      expect(first.body.data).toHaveLength(3);
      await sale('stable_new_1');
      await sale('stable_new_2');
      const second = await get(`/payments?limit=3&cursor=${first.body.nextCursor}`);
      const seen = new Set(first.body.data.map((p: any) => p.id));
      expect(second.body.data.every((p: any) => !seen.has(p.id))).toBe(true); // no duplicates
      expect(second.body.data.map((p: any) => p.sellerId)).toEqual(['stable_1', 'stable_0']); // the 2 older ones, nothing skipped
      expect(second.body.nextCursor).toBeNull();
    });

    it('filters by seller, buyer, status, provider and creation window, and combines filters', async () => {
      const a = await sale('f_a', { buyerId: 'buyer_x' });
      await sale('f_b', { buyerId: 'buyer_y' });
      const declined = (await post('/payments', newPayment({ sellerId: 'f_a', paymentMethod: 'pm_card_declined' }), { 'idempotency-key': key() })).body.payment;
      const authorizedOnly = await sale('f_c', { capture: false });

      const ids = async (q: string) => (await get(`/payments?${q}`)).body.data.map((p: any) => p.id).sort();
      expect(await ids('sellerId=f_a')).toEqual([a.id, declined.id].sort());
      expect(await ids('sellerId=f_a&status=failed')).toEqual([declined.id]);
      expect(await ids('buyerId=buyer_y')).toHaveLength(1);
      expect(await ids('status=authorized')).toEqual([authorizedOnly.id]);
      expect(await ids('provider=simulated')).toHaveLength(4);
      expect(await ids('provider=stripe')).toEqual([]);
      expect(await ids(`createdFrom=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual([]);
      expect(await ids(`createdTo=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`)).toEqual([]);
      expect(await ids(`createdFrom=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`)).toHaveLength(4);
    });

    it.each([['limit=0'], ['limit=201'], ['limit=abc'], ['status=nonsense'], ['createdFrom=yesterday'], ['unknownFilter=1']])(
      'rejects bad query %s with 400',
      async (q) => {
        expect((await get(`/payments?${q}`)).status).toBe(400);
      },
    );

    it('rejects a tampered cursor with 400 invalid_cursor', async () => {
      const res = await get('/payments?cursor=bm90LWEtY3Vyc29y');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_cursor' });
    });

    it.each(['/payments', '/payouts', '/disputes', '/ledger/entries', '/webhooks/dead-letters'])(
      'rejects a well-formed cursor with garbage values on %s with 400 (never a 500)',
      async (path) => {
        const cursor = Buffer.from(JSON.stringify({ t: "x'; DROP TABLE payments;--", i: 'nope', p: 'p', e: 'e' })).toString('base64url');
        const res = await get(`${path}?cursor=${cursor}`);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'invalid_cursor' });
      },
    );

    it('is available to client keys', async () => {
      await sale('client_view');
      expect((await get('/payments', client)).status).toBe(200);
    });
  });

  describe('GET /payouts', () => {
    it('is paginated and filterable by seller and status', async () => {
      for (const s of ['po_a', 'po_b', 'po_c']) await sale(s);
      const run = (await post('/payouts/run', { asOf: in3Days() })).body;
      expect(run.filter((l: any) => l.payoutId)).toHaveLength(3);
      await waitFor(async () => (await get('/payouts?status=pending')).body.data.length === 0, 15000, 'payouts settled');
      const { items } = await pageThrough('/payouts', 2);
      expect(items.map((p: any) => p.sellerId).sort()).toEqual(['po_a', 'po_b', 'po_c']);
      expect((await get('/payouts?sellerId=po_b')).body.data).toHaveLength(1);
      expect((await get('/payouts?status=paid')).body.data).toHaveLength(3);
      expect((await get('/payouts?status=failed')).body.data).toEqual([]);
      expect((await get('/payouts?status=bogus')).status).toBe(400);
    });
  });

  describe('GET /webhooks/dead-letters', () => {
    it('is paginated, newest first', async () => {
      for (let i = 0; i < 5; i++) {
        await t.db.query(
          `INSERT INTO webhook_events (provider, event_id, type, payload, status, received_at)
           VALUES ('simulated', $1, 'x', '{}', 'dead', now() - ($2 || ' minutes')::interval)`,
          [`evt_dead_${i}`, String(i)],
        );
      }
      const { items, pages } = await pageThrough('/webhooks/dead-letters', 2);
      expect(pages).toBe(3);
      expect(items.map((e: any) => e.eventId)).toEqual(['evt_dead_0', 'evt_dead_1', 'evt_dead_2', 'evt_dead_3', 'evt_dead_4']);
    });
  });

  describe('GET /disputes', () => {
    it('lists disputes with filters', async () => {
      const p = await sale('disp_list');
      await t.sim.deliver(evt('dispute.opened', { disputeRef: 'dp_l1', providerRef: p.providerRef, amount: 10000, currency: 'USD', reason: 'fraudulent' }));
      await waitFor(async () => (await get('/disputes')).body.data.length === 1, 15000, 'dispute recorded');
      expect((await get('/disputes')).body.data[0]).toMatchObject({ providerRef: 'dp_l1', paymentId: p.id, status: 'open', amount: 10000, currency: 'USD', reason: 'fraudulent' });
      expect((await get(`/disputes?paymentId=${p.id}`)).body.data).toHaveLength(1);
      expect((await get('/disputes?status=won')).body.data).toEqual([]);
      expect((await get('/disputes?paymentId=not-a-uuid')).status).toBe(400);
    });
  });

  describe('GET /ledger/entries', () => {
    it('lists journal entries with their balanced postings, and filters them', async () => {
      const p = await sale('led_a');
      await post(`/payments/${p.id}/refunds`, { amount: 2000 }, { 'idempotency-key': key() });
      await sale('led_b');

      const all = (await get('/ledger/entries')).body.data;
      expect(all).toHaveLength(3);
      for (const entry of all) {
        expect(entry.postings.reduce((s: number, x: any) => s + x.amount, 0)).toBe(0); // every entry balances
        expect(entry.postings.every((x: any) => typeof x.accountCode === 'string' && x.currency === 'USD')).toBe(true);
      }
      const capture = (await get(`/ledger/entries?kind=capture&paymentId=${p.id}`)).body.data;
      expect(capture).toHaveLength(1);
      expect(capture[0]).toMatchObject({ kind: 'capture', paymentId: p.id, referenceKey: `capture:${p.id}` });
      expect(capture[0].postings.map((x: any) => x.accountCode).sort()).toEqual(['platform:clearing:USD', 'platform:fees:USD', 'seller:led_a:USD']);
      expect((await get('/ledger/entries?accountCode=seller:led_b:USD')).body.data).toHaveLength(1);
      expect((await get('/ledger/entries?kind=refund')).body.data).toHaveLength(1);
      expect((await get('/ledger/entries?kind=nothing_like_this')).body.data).toEqual([]);
    });

    it('pages without gaps or duplicates', async () => {
      for (let i = 0; i < 6; i++) await sale(`led_p${i}`);
      const { items, pages } = await pageThrough('/ledger/entries', 4);
      expect(pages).toBe(2);
      expect(new Set(items.map((e: any) => e.id)).size).toBe(6);
    });
  });

  describe('GET /ledger/accounts/:code/statement', () => {
    it('lists postings newest-first with a running balance that chains correctly across pages', async () => {
      const first = await sale('stmt', { amount: 10000 });
      await sale('stmt', { amount: 5000 });
      await post(`/payments/${first.id}/refunds`, { amount: 4000 }, { 'idempotency-key': key() });
      await sale('stmt', { amount: 2000 });
      const code = 'seller:stmt:USD';
      const current = (await get(`/ledger/accounts/${code}`)).body.balance;
      expect(current).toBe(9000 + 4500 - 3600 + 1800);

      const { items } = await pageThrough(`/ledger/accounts/${code}/statement`, 2);
      expect(items).toHaveLength(4);
      expect(items.map((r: any) => r.kind)).toEqual(['capture', 'refund', 'capture', 'capture']); // newest first
      expect(items[0].balanceAfter).toBe(current);
      for (let i = 0; i < items.length - 1; i++) expect(items[i].balanceAfter - items[i].delta).toBe(items[i + 1].balanceAfter);
      expect(items.at(-1).balanceAfter - items.at(-1).delta).toBe(0); // the account started at zero
      expect(items[1]).toMatchObject({ kind: 'refund', paymentId: first.id, delta: -3600, amount: 3600 });
    });

    it('keeps the chain consistent when postings arrive between pages', async () => {
      for (let i = 0; i < 4; i++) await sale('stmt2', { amount: 1000 });
      const code = 'seller:stmt2:USD';
      const page1 = await get(`/ledger/accounts/${code}/statement?limit=2`);
      await sale('stmt2', { amount: 7000 }); // lands after page 1 was read
      const page2 = await get(`/ledger/accounts/${code}/statement?limit=2&cursor=${page1.body.nextCursor}`);
      const rows = [...page1.body.data, ...page2.body.data];
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r: any) => r.postingId)).size).toBe(4);
      for (let i = 0; i < rows.length - 1; i++) expect(rows[i].balanceAfter - rows[i].delta).toBe(rows[i + 1].balanceAfter);
      expect(rows.at(-1).balanceAfter - rows.at(-1).delta).toBe(0);
    });

    it('reports the account and 404s for unknown accounts', async () => {
      await sale('stmt3');
      const res = await get('/ledger/accounts/seller:stmt3:USD/statement');
      expect(res.body.account).toMatchObject({ code: 'seller:stmt3:USD', type: 'liability', currency: 'USD', balance: 9000 });
      expect((await get('/ledger/accounts/seller:nobody:USD/statement')).status).toBe(404);
    });
  });

  describe('access control', () => {
    it.each(['/payouts', '/disputes', '/webhooks/dead-letters', '/ledger/entries', '/ledger/accounts/platform:fees:USD/statement'])(
      'keeps %s admin-only',
      async (path) => {
        expect((await get(path, client)).status).toBe(403);
        expect((await t.call('GET', path)).status).toBe(401);
      },
    );
  });
});
