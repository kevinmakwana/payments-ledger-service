import { compare } from './reconciliation.service';

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
