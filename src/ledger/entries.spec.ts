import fc from 'fast-check';
import { cumulativeFeeRefund, feeFor } from '../common/money';
import { captureLines, payoutInitiatedLines, payoutReversedLines, payoutSettledLines, refundLines } from './entries';
import { assertBalanced, UnbalancedEntryError } from './ledger.service';

const sum = (lines: { amount: number }[]) => lines.reduce((s, l) => s + l.amount, 0);

describe('ledger entry builders (property-style)', () => {
  const money = fc.integer({ min: 1, max: 1_000_000_000 });
  const bps = fc.integer({ min: 0, max: 10_000 });

  it('capture entries always balance for any amount and fee', () => {
    fc.assert(
      fc.property(money, bps, fc.constantFrom('USD', 'EUR', 'INR'), (amount, feeBps, currency) => {
        const lines = captureLines({ sellerId: 's1', currency, amount, fee: feeFor(amount, feeBps) });
        assertBalanced(lines);
        expect(sum(lines)).toBe(0);
      }),
    );
  });

  it('any sequence of partial refunds balances and never refunds more fee than was charged', () => {
    fc.assert(
      fc.property(money, bps, fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), { minLength: 1, maxLength: 12 }), (amount, feeBps, shares) => {
        const fee = feeFor(amount, feeBps);
        let refunded = 0;
        let feeRefunded = 0;
        for (const share of shares) {
          const part = Math.min(amount - refunded, Math.max(1, Math.floor(amount * share)));
          if (part <= 0) break;
          refunded += part;
          const feeRefund = cumulativeFeeRefund(fee, amount, refunded) - feeRefunded;
          feeRefunded += feeRefund;
          const lines = refundLines({ sellerId: 's1', currency: 'USD', amount: part, feeRefund });
          assertBalanced(lines);
        }
        expect(feeRefunded).toBeLessThanOrEqual(fee);
        if (refunded === amount) expect(feeRefunded).toBe(fee);
      }),
    );
  });

  it('payout lifecycle entries all balance', () => {
    fc.assert(
      fc.property(money, (amount) => {
        for (const lines of [
          payoutInitiatedLines({ sellerId: 's', currency: 'USD', amount }),
          payoutSettledLines({ currency: 'USD', amount }),
          payoutReversedLines({ sellerId: 's', currency: 'USD', amount }),
        ]) {
          assertBalanced(lines);
        }
      }),
    );
  });

  it('rejects unbalanced, single-sided and zero-amount entries', () => {
    const [a, b] = captureLines({ sellerId: 's', currency: 'USD', amount: 100, fee: 10 });
    expect(() => assertBalanced([a, b])).toThrow(UnbalancedEntryError);
    expect(() => assertBalanced([a])).toThrow(UnbalancedEntryError);
    expect(() => assertBalanced([{ ...a, amount: 0 }, { ...b, amount: 0 }])).toThrow(UnbalancedEntryError);
  });

  it('rejects entries that balance only across different currencies', () => {
    const usd = captureLines({ sellerId: 's', currency: 'USD', amount: 100, fee: 0 });
    const eur = captureLines({ sellerId: 's', currency: 'EUR', amount: 50, fee: 0 });
    expect(() => assertBalanced([usd[0], eur[1]])).toThrow(UnbalancedEntryError);
  });
});
