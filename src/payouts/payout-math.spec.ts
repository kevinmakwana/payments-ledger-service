import { holdCutoff, payableAmount } from './payout-math';

describe('payout calculation', () => {
  it('pays matured credits minus reserve', () => {
    expect(payableAmount({ maturedCredits: 9000, debits: 0 }, 500)).toBe(8500);
  });

  it('refunds and earlier payouts reduce the payable amount', () => {
    expect(payableAmount({ maturedCredits: 9000, debits: 2700 }, 500)).toBe(5800);
  });

  it('never goes negative (reserve larger than balance, or seller owes the platform)', () => {
    expect(payableAmount({ maturedCredits: 300, debits: 0 }, 500)).toBe(0);
    expect(payableAmount({ maturedCredits: 0, debits: 900 }, 0)).toBe(0);
  });

  it('computes the hold cutoff in days', () => {
    const asOf = new Date('2026-03-10T12:00:00Z');
    expect(holdCutoff(asOf, 2).toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(holdCutoff(asOf, 0).toISOString()).toBe(asOf.toISOString());
  });
});
