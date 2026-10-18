import fc from 'fast-check';
import { allocateAcrossProviders, holdCutoff, payableAmount } from './payout-math';

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

describe('allocateAcrossProviders', () => {
  it('puts everything on the only provider', () => {
    expect(allocateAcrossProviders(8500, { stripe: 9000 })).toEqual([{ provider: 'stripe', amount: 8500 }]);
  });

  it('uses a single leg on the provider with the most money when it can cover the total', () => {
    expect(allocateAcrossProviders(4000, { stripe: 3000, razorpay: 9000 })).toEqual([{ provider: 'razorpay', amount: 4000 }]);
  });

  it('spills over to the next provider only for what the first cannot cover', () => {
    expect(allocateAcrossProviders(9000, { stripe: 5000, razorpay: 6000 })).toEqual([
      { provider: 'razorpay', amount: 6000 },
      { provider: 'stripe', amount: 3000 },
    ]);
  });

  it('never asks a provider for more than that provider took, even if the total is larger', () => {
    expect(allocateAcrossProviders(20000, { stripe: 5000, razorpay: 6000 })).toEqual([
      { provider: 'razorpay', amount: 6000 },
      { provider: 'stripe', amount: 5000 },
    ]);
  });

  it('ignores providers with no money or a negative net (refunds exceeded their sales)', () => {
    expect(allocateAcrossProviders(1000, { stripe: -400, razorpay: 0, simulated: 2000 })).toEqual([{ provider: 'simulated', amount: 1000 }]);
  });

  it('breaks ties by provider name so batches are deterministic', () => {
    expect(allocateAcrossProviders(150, { stripe: 100, razorpay: 100 })).toEqual([
      { provider: 'razorpay', amount: 100 },
      { provider: 'stripe', amount: 50 },
    ]);
  });

  it('allocates nothing for a zero total', () => {
    expect(allocateAcrossProviders(0, { stripe: 100 })).toEqual([]);
  });

  it('property: allocates min(total, sum of positive caps), never exceeds a cap, no empty legs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.dictionary(fc.constantFrom('stripe', 'razorpay', 'simulated', 'adyen'), fc.integer({ min: -50_000, max: 500_000 })),
        (total, caps) => {
          const legs = allocateAcrossProviders(total, caps);
          const sum = legs.reduce((a, l) => a + l.amount, 0);
          const available = Object.values(caps).reduce((a, c) => a + Math.max(0, c), 0);
          expect(sum).toBe(Math.min(total, available));
          for (const l of legs) {
            expect(l.amount).toBeGreaterThan(0);
            expect(l.amount).toBeLessThanOrEqual(caps[l.provider]);
          }
          expect(new Set(legs.map((l) => l.provider)).size).toBe(legs.length);
        },
      ),
    );
  });
});

