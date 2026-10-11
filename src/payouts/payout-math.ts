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
