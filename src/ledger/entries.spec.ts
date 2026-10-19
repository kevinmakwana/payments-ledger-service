import fc from 'fast-check';
import { cumulativeFeeRefund, feeFor } from '../common/money';
import {
  captureLines,
  disputeLostLines,
  disputeOpenedLines,
  disputeWonLines,
  payoutInitiatedLines,
  payoutReversedLines,
  payoutSettledLines,
  refundLines,
} from './entries';
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

describe('dispute entries', () => {
  const money = fc.integer({ min: 1, max: 1_000_000_000 });
  const net = (...entries: { account: { code: string }; amount: number }[][]) => {
    const by = new Map<string, number>();
    for (const l of entries.flat()) by.set(l.account.code, (by.get(l.account.code) ?? 0) + l.amount);
    return Object.fromEntries([...by].filter(([, v]) => v !== 0));
  };
  const parts = fc
    .tuple(money, fc.integer({ min: 0, max: 10_000 }))
    .map(([amount, bps]) => ({ amount, feePart: Math.floor((amount * bps) / 10_000) }));
  const args = (a: { amount: number; feePart: number }) => ({ sellerId: 's1', currency: 'USD', ...a });

  it('opening, winning and losing a dispute each balance for any amount and fee share', () => {
    fc.assert(
      fc.property(parts, (a) => {
        for (const lines of [disputeOpenedLines(args(a)), disputeWonLines(args(a)), disputeLostLines(args(a))]) assertBalanced(lines);
      }),
    );
  });

  it('opened then won nets to zero on every account: nothing was lost', () => {
    fc.assert(fc.property(parts, (a) => expect(net(disputeOpenedLines(args(a)), disputeWonLines(args(a)))).toEqual({})));
  });

  it('opened then lost has exactly the effect of a refund: provider cash gone, seller bears their share, platform returns its fee share', () => {
    fc.assert(
      fc.property(parts, (a) => {
        const refund = refundLines({ sellerId: 's1', currency: 'USD', amount: a.amount, feeRefund: a.feePart });
        expect(net(disputeOpenedLines(args(a)), disputeLostLines(args(a)))).toEqual(net(refund));
      }),
    );
  });

  it('while open, the money sits in disputed funds and the seller share in the hold account', () => {
    expect(net(disputeOpenedLines({ sellerId: 's1', currency: 'USD', amount: 10_000, feePart: 1_000 }))).toEqual({
      'platform:clearing:USD': -10_000,
      'platform:disputed_funds:USD': 10_000,
      'seller:s1:USD': 9_000,
      'platform:dispute_holds:USD': -9_000,
    });
  });

  it('a 100% fee leaves no seller share, and zero postings are never produced', () => {
    for (const lines of [disputeOpenedLines(args({ amount: 500, feePart: 500 })), disputeLostLines(args({ amount: 500, feePart: 500 }))]) {
      assertBalanced(lines);
      expect(lines.every((l) => l.amount !== 0)).toBe(true);
    }
  });
});

