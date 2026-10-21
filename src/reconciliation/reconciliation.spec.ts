import { compare, compareForDay } from './reconciliation.service';

const ptx = (id: string, amount: number, type: 'charge' | 'refund' | 'payout' = 'charge') => ({
  id, type, amount, currency: 'USD', createdAt: '2026-03-10T10:00:00Z',
});
const led = (ref: string, amount: number, kind: 'charge' | 'refund' | 'payout' = 'charge') => ({
  entryId: `e_${ref}`, kind, ref, amount, currency: 'USD',
});

describe('reconciliation compare', () => {
  it('matches identical sets', () => {
    expect(compare([ptx('a', 100), ptx('r', 40, 'refund')], [led('a', 100), led('r', 40, 'refund')])).toEqual({ matched: 2, mismatches: [] });
  });

  it('reports all three mismatch kinds', () => {
    const { matched, mismatches } = compare(
      [ptx('a', 100), ptx('b', 200), ptx('only_provider', 50)],
      [led('a', 100), led('b', 199), led('only_ledger', 70)],
    );
    expect(matched).toBe(1);
    expect(mismatches.map((m) => [m.type, m.ref])).toEqual(
      expect.arrayContaining([
        ['amount_mismatch', 'b'],
        ['missing_in_ledger', 'only_provider'],
        ['missing_at_provider', 'only_ledger'],
      ]),
    );
    expect(mismatches).toHaveLength(3);
    expect(mismatches.find((m) => m.ref === 'b')).toMatchObject({ providerAmount: 200, ledgerAmount: 199 });
  });

  it('does not confuse the same ref used by different transaction types', () => {
    const { mismatches } = compare([ptx('x', 10, 'charge')], [led('x', 10, 'refund')]);
    expect(mismatches).toHaveLength(2);
  });
});

describe('compareForDay (±1 day window)', () => {
  const at = (day: string, id: string, amount = 100, type: 'charge' | 'refund' | 'payout' = 'charge') => ({
    id, type, amount, currency: 'USD', createdAt: `${day}T12:00:00Z`,
  });
  const ledgerAt = (day: string, ref: string, amount = 100) => ({ entryId: `e_${ref}`, kind: 'charge' as const, ref, amount, currency: 'USD', day });

  it('matches a transaction the provider dated on one side of midnight and we recorded on the other, on both days', () => {
    const providerTxs = [at('2026-03-10', 'edge')];
    const ledger = [ledgerAt('2026-03-11', 'edge')];
    for (const day of ['2026-03-10', '2026-03-11']) {
      const r = compareForDay(day, providerTxs, ledger);
      expect(r.mismatches).toEqual([]);
    }
    expect(compareForDay('2026-03-10', providerTxs, ledger)).toMatchObject({ providerTransactions: 1, ledgerEntries: 0, matched: 1 });
    expect(compareForDay('2026-03-11', providerTxs, ledger)).toMatchObject({ providerTransactions: 0, ledgerEntries: 1, matched: 0 });
  });

  it('reports a finding only on the day it belongs to, even though it is visible from the neighbouring days', () => {
    const providerTxs = [at('2026-03-10', 'ghost')];
    expect(compareForDay('2026-03-10', providerTxs, []).mismatches).toMatchObject([{ type: 'missing_in_ledger', ref: 'ghost', day: '2026-03-10' }]);
    expect(compareForDay('2026-03-09', providerTxs, []).mismatches).toEqual([]);
    expect(compareForDay('2026-03-11', providerTxs, []).mismatches).toEqual([]);
    const ledger = [ledgerAt('2026-03-10', 'orphan')];
    expect(compareForDay('2026-03-10', [], ledger).mismatches).toMatchObject([{ type: 'missing_at_provider', ref: 'orphan', day: '2026-03-10' }]);
    expect(compareForDay('2026-03-11', [], ledger).mismatches).toEqual([]);
  });

  it('still catches an amount mismatch, attributed to the provider\'s day', () => {
    const r = compareForDay('2026-03-10', [at('2026-03-10', 'x', 100)], [ledgerAt('2026-03-11', 'x', 99)]);
    expect(r.mismatches).toMatchObject([{ type: 'amount_mismatch', providerAmount: 100, ledgerAmount: 99, day: '2026-03-10' }]);
    expect(r.matched).toBe(0);
  });
});

describe('fee comparison', () => {
  const charge = (id: string, amount: number, fee?: number) => ({ id, type: 'charge' as const, amount, currency: 'USD', createdAt: '2026-03-10T10:00:00Z', fee });
  const entry = (ref: string, amount: number, fee?: number) => ({ entryId: `e_${ref}`, kind: 'charge' as const, ref, amount, currency: 'USD', fee });

  it('matches when the provider fee equals the booked fee, and treats "no fee booked" as 0', () => {
    expect(compare([charge('a', 100, 5)], [entry('a', 100, 5)]).mismatches).toEqual([]);
    expect(compare([charge('a', 100, 0)], [entry('a', 100)]).mismatches).toEqual([]);
  });

  it('flags a different fee, with the provider figure first', () => {
    expect(compare([charge('a', 100, 7)], [entry('a', 100, 5)]).mismatches).toMatchObject([
      { type: 'fee_mismatch', ref: 'a', providerAmount: 7, ledgerAmount: 5 },
    ]);
  });

  it('ignores fees entirely when the provider does not report one', () => {
    expect(compare([charge('a', 100, undefined)], [entry('a', 100, 5)]).mismatches).toEqual([]);
  });

  it('reports one finding per transaction: an amount mismatch takes precedence over a fee mismatch', () => {
    expect(compare([charge('a', 100, 7)], [entry('a', 99, 5)]).mismatches.map((m) => m.type)).toEqual(['amount_mismatch']);
  });
});
