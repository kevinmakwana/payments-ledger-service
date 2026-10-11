/** Largest amount accepted anywhere (minor units). Keeps every sum exact in a JS number. */
export const MAX_AMOUNT_MINOR = 100_000_000_000;

/** Platform fee in minor units, rounded down (the seller never pays a fractional cent). */
export function feeFor(amount: number, feeBps: number): number {
  return Number((BigInt(amount) * BigInt(feeBps)) / 10_000n);
}

/**
 * Fee portion to give back when `refundedTotal` of `amount` has been refunded in
 * total, minus what was already returned. Proportional and rounded down on the
 * cumulative total, so a series of partial refunds always sums to exactly `fee`.
 */
export function cumulativeFeeRefund(fee: number, amount: number, refundedTotal: number): number {
  // fee * refundedTotal can exceed 2^53, so multiply in BigInt.
  return Number((BigInt(fee) * BigInt(refundedTotal)) / BigInt(amount));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
