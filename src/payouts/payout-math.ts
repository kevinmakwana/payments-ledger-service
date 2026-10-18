export interface SellerBalanceParts {
  /** Sum of credits (sales) whose hold period has elapsed. */
  maturedCredits: number;
  /** Sum of all debits (refunds, payouts in flight or paid). Debits always count immediately. */
  debits: number;
}

/**
 * Amount a seller can be paid out now:
 *   (credits older than the hold period) - (all debits) - reserve, never below zero.
 * Recent sales stay held, refunds reduce what is payable immediately, and the reserve
 * is always left behind as a buffer against future refunds/chargebacks.
 */
export function payableAmount(parts: SellerBalanceParts, reserve: number): number {
  return Math.max(0, parts.maturedCredits - parts.debits - reserve);
}

export function holdCutoff(asOf: Date, holdDays: number): Date {
  return new Date(asOf.getTime() - holdDays * 24 * 60 * 60 * 1000);
}

export interface PayoutLeg {
  provider: string;
  amount: number;
}

/**
 * Splits a seller's payable `total` into one leg per provider, never asking a provider for more than
 * it took in for that seller (`caps`: that provider's matured credits minus its debits; negative nets count as 0).
 * Largest cap first, so the common case stays a single payout and tiny legs are avoided; ties by name.
 * The seller-level total is unchanged, only the routing differs.
 */
export function allocateAcrossProviders(total: number, caps: Record<string, number>): PayoutLeg[] {
  const ordered = Object.entries(caps)
    .filter(([, cap]) => cap > 0)
    .sort(([a, capA], [b, capB]) => capB - capA || (a < b ? -1 : 1));
  const legs: PayoutLeg[] = [];
  let remaining = total;
  for (const [provider, cap] of ordered) {
    if (remaining <= 0) break;
    const amount = Math.min(remaining, cap);
    legs.push({ provider, amount });
    remaining -= amount;
  }
  return legs;
}

