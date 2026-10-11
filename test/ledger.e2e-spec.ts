import fc from 'fast-check';
import { PoolClient } from 'pg';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

describeE2E('ledger (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await resetDb(t.db);
  });
  afterAll(() => t.close());

  const rawEntry = async (client: PoolClient, amounts: number[], key: string) => {
    const acct = (await client.query(`INSERT INTO accounts (code, type, currency) VALUES ($1,'asset','USD')
      ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`, ['test:raw'])).rows[0].id;
    const e = (await client.query(`INSERT INTO journal_entries (kind, reference_key) VALUES ('test',$1) RETURNING id`, [key])).rows[0].id;
    for (const a of amounts) await client.query('INSERT INTO postings (entry_id, account_id, currency, amount) VALUES ($1,$2,$3,$4)', [e, acct, 'USD', a]);
  };

  describe('database-level guarantees', () => {
    it('refuses to COMMIT an unbalanced journal entry', async () => {
      await expect(t.db.tx((c) => rawEntry(c, [100, -90], key()))).rejects.toThrow(/unbalanced/);
    });

    it('refuses a single-posting entry', async () => {
      await expect(t.db.tx((c) => rawEntry(c, [100], key()))).rejects.toThrow(/at least 2 postings/);
    });

    it('accepts a balanced entry', async () => {
      await expect(t.db.tx((c) => rawEntry(c, [100, -100], key()))).resolves.toBeUndefined();
    });

    it('treats postings as append-only', async () => {
      await expect(t.db.query('UPDATE postings SET amount = amount + 1')).rejects.toThrow(/immutable/);
      await expect(t.db.query('DELETE FROM postings')).rejects.toThrow(/immutable/);
    });

    it('rejects postings whose currency differs from the account currency', async () => {
      await expect(
        t.db.tx(async (c) => {
          const a = (await c.query(`SELECT id FROM accounts WHERE code = 'test:raw'`)).rows[0].id;
          const e = (await c.query(`INSERT INTO journal_entries (kind, reference_key) VALUES ('test',$1) RETURNING id`, [key()])).rows[0].id;
          await c.query(`INSERT INTO postings (entry_id, account_id, currency, amount) VALUES ($1,$2,'EUR',5)`, [e, a]);
        }),
      ).rejects.toThrow(/foreign key/);
    });
  });

  it('random sequences of captures and refunds always leave the ledger balanced and caches consistent', async () => {
    const op = fc.record({
      amount: fc.integer({ min: 1, max: 5_000_000 }),
      seller: fc.constantFrom('s_a', 's_b', 's_c'),
      currency: fc.constantFrom('USD', 'EUR'),
      capture: fc.boolean(),
      refunds: fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 4 }), // percent of the *remaining* amount
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), async (ops) => {
        for (const o of ops) {
          const p = (await t.call('POST', '/payments', newPayment({ amount: o.amount, sellerId: o.seller, currency: o.currency }), { 'idempotency-key': key() })).body;
          if (!o.capture) continue;
          await t.call('POST', `/payments/${p.id}/capture`);
          let remaining = o.amount;
          for (const pct of o.refunds) {
            const amount = Math.max(1, Math.floor((remaining * pct) / 100));
            if (amount > remaining) break;
            const r = await t.call('POST', `/payments/${p.id}/refunds`, { amount }, { 'idempotency-key': key() });
            expect(r.status).toBe(201);
            remaining -= amount;
          }
        }
        const tb = (await t.call('GET', '/ledger/trial-balance')).body;
        expect(tb.balanced).toBe(true);
        expect(tb.currencyTotals.every((c: { total: number }) => c.total === 0)).toBe(true);
        expect(tb.accounts.every((a: { cacheConsistent: boolean }) => a.cacheConsistent)).toBe(true);
      }),
      { numRuns: 15 },
    );
  });

  it('splits a capture into clearing / seller / fee and returns the fee pro rata on refund', async () => {
    await t.drain();
    await resetDb(t.db);
    const p = (await t.call('POST', '/payments', newPayment({ sellerId: 'split_seller', amount: 9999, capture: true }), { 'idempotency-key': key() })).body;
    expect(p.feeAmount).toBe(999); // floor(9999 * 10%)
    const bal = async (code: string) => (await t.call('GET', `/ledger/accounts/${code}`)).body.balance;
    expect(await bal('platform:clearing:USD')).toBe(9999);
    expect(await bal('seller:split_seller:USD')).toBe(9000);
    expect(await bal('platform:fees:USD')).toBe(999);
    await t.call('POST', `/payments/${p.id}/refunds`, {}, { 'idempotency-key': key() });
    expect(await bal('platform:clearing:USD')).toBe(0);
    expect(await bal('seller:split_seller:USD')).toBe(0);
    expect(await bal('platform:fees:USD')).toBe(0);
  });
});
