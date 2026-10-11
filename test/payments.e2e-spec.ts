import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

describeE2E('payments (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  const create = (over = {}, k = key()) => t.call('POST', '/payments', newPayment(over), { 'idempotency-key': k });

  describe('idempotency', () => {
    it('requires an Idempotency-Key', async () => {
      const r = await t.call('POST', '/payments', newPayment());
      expect(r.status).toBe(400);
    });

    it('replays the identical response for the same key + body, creating only one payment', async () => {
      const k = key();
      const a = await create({ buyerId: 'replay_buyer' }, k);
      const b = await create({ buyerId: 'replay_buyer' }, k);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body).toEqual(a.body);
      expect(b.headers.get('idempotent-replayed')).toBe('true');
      expect(a.headers.get('idempotent-replayed')).toBeNull();
      const count = await t.db.query("SELECT count(*)::int AS n FROM payments WHERE buyer_id = 'replay_buyer'");
      expect(count.rows[0].n).toBe(1);
    });

    it('returns 409 when the key is reused with a different body', async () => {
      const k = key();
      expect((await create({ amount: 5000 }, k)).status).toBe(201);
      const conflict = await create({ amount: 5001 }, k);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('idempotency_key_reuse');
    });

    it('handles concurrent requests with one key: one payment, identical responses', async () => {
      const k = key();
      const rs = await Promise.all(Array.from({ length: 8 }, () => create({ buyerId: 'race_buyer' }, k)));
      expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
      expect(rs.every((r) => r.status === 201)).toBe(true);
      const count = await t.db.query("SELECT count(*)::int AS n FROM payments WHERE buyer_id = 'race_buyer'");
      expect(count.rows[0].n).toBe(1);
    });

    it('does not remember failed attempts (validation errors leave the key reusable)', async () => {
      const k = key();
      expect((await create({ amount: -5 }, k)).status).toBe(400);
      expect((await create({ amount: 5 }, k)).status).toBe(201);
    });

    it('replays refunds too', async () => {
      const p = (await create({ capture: true })).body;
      const k = key();
      const a = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1000 }, { 'idempotency-key': k });
      const b = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1000 }, { 'idempotency-key': k });
      expect(b.body).toEqual(a.body);
      expect((await t.call('GET', `/payments/${p.id}`)).body.refundedAmount).toBe(1000);
    });
  });

  describe('state machine over HTTP', () => {
    it('walks authorized -> captured -> partially_refunded -> refunded', async () => {
      const p = (await create()).body;
      expect(p.status).toBe('authorized');
      expect(p.feeAmount).toBe(1000);
      expect((await t.call('POST', `/payments/${p.id}/capture`)).body.status).toBe('captured');
      const r1 = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 2500 }, { 'idempotency-key': key() });
      expect(r1.body.status).toBe('partially_refunded');
      const r2 = await t.call('POST', `/payments/${p.id}/refunds`, {}, { 'idempotency-key': key() });
      expect(r2.body.status).toBe('refunded');
      expect(r2.body.refundedAmount).toBe(10000);
    });

    it('rejects illegal transitions with 409', async () => {
      const p = (await create()).body;
      const early = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 100 }, { 'idempotency-key': key() });
      expect(early.status).toBe(409); // refund before capture
      expect(early.body.code).toBe('illegal_transition');
      await t.call('POST', `/payments/${p.id}/capture`);
      expect((await t.call('POST', `/payments/${p.id}/capture`)).status).toBe(409); // double capture
      await t.call('POST', `/payments/${p.id}/refunds`, {}, { 'idempotency-key': key() });
      const again = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 1 }, { 'idempotency-key': key() });
      expect(again.status).toBe(409); // refunded is terminal
    });

    it('rejects refunds above the refundable amount', async () => {
      const p = (await create({ capture: true })).body;
      const r = await t.call('POST', `/payments/${p.id}/refunds`, { amount: 10001 }, { 'idempotency-key': key() });
      expect(r.status).toBe(422);
    });
  });

  describe('concurrency', () => {
    it('20 parallel captures of one payment: exactly one succeeds, one ledger entry', async () => {
      const p = (await create()).body;
      const rs = await Promise.all(Array.from({ length: 20 }, () => t.call('POST', `/payments/${p.id}/capture`)));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(19);
      const entries = await t.db.query("SELECT count(*)::int AS n FROM journal_entries WHERE payment_id = $1 AND kind = 'capture'", [p.id]);
      expect(entries.rows[0].n).toBe(1);
      const tb = (await t.call('GET', '/ledger/trial-balance')).body;
      expect(tb.balanced).toBe(true);
    });

    it('parallel refunds can never exceed the captured amount', async () => {
      const p = (await create({ amount: 10000, capture: true })).body;
      // 12 x 1500 = 18000 requested against 10000 refundable => at most 6 can succeed (9000), 7th would exceed.
      const rs = await Promise.all(
        Array.from({ length: 12 }, () => t.call('POST', `/payments/${p.id}/refunds`, { amount: 1500 }, { 'idempotency-key': key() })),
      );
      const ok = rs.filter((r) => r.status === 201);
      expect(ok).toHaveLength(6);
      expect(rs.filter((r) => r.status !== 201).every((r) => r.status === 422)).toBe(true);
      const final = (await t.call('GET', `/payments/${p.id}`)).body;
      expect(final.refundedAmount).toBe(9000);
      expect(final.status).toBe('partially_refunded');
      const refunds = await t.db.query('SELECT sum(amount)::int AS s, count(*)::int AS n FROM refunds WHERE payment_id = $1', [p.id]);
      expect(refunds.rows[0]).toEqual({ s: 9000, n: 6 });
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });

    it('concurrent capture and refund never leave an inconsistent payment', async () => {
      const p = (await create()).body;
      const [cap, ref] = await Promise.all([
        t.call('POST', `/payments/${p.id}/capture`),
        t.call('POST', `/payments/${p.id}/refunds`, { amount: 100 }, { 'idempotency-key': key() }),
      ]);
      expect(cap.status).toBe(200);
      // Refund either ran after the capture (201) or was rejected because nothing was captured yet (409).
      expect([201, 409]).toContain(ref.status);
      expect((await t.call('GET', '/ledger/trial-balance')).body.balanced).toBe(true);
    });
  });
});
