export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense';

export interface AccountRef {
  code: string;
  type: AccountType;
  currency: string;
}

/** Funds the platform holds at the payment provider (not yet paid out). */
export const clearing = (currency: string): AccountRef => ({
  code: `platform:clearing:${currency}`,
  type: 'asset',
  currency,
});

/** Platform fee revenue. */
export const fees = (currency: string): AccountRef => ({
  code: `platform:fees:${currency}`,
  type: 'revenue',
  currency,
});

/** What the platform owes a seller. */
export const sellerPayable = (sellerId: string, currency: string): AccountRef => ({
  code: `seller:${sellerId}:${currency}`,
  type: 'liability',
  currency,
});

/** Money handed to the provider for payout but not yet confirmed. */
export const payoutsInTransit = (currency: string): AccountRef => ({
  code: `platform:payouts_in_transit:${currency}`,
  type: 'liability',
  currency,
});

/** Money the provider withdrew for an open dispute and that we may win back (a receivable from the provider). */
export const disputedFunds = (currency: string): AccountRef => ({
  code: `platform:disputed_funds:${currency}`,
  type: 'asset',
  currency,
});

/** The seller's share of open disputes, withheld from their payable balance until the dispute resolves. */
export const disputeHolds = (currency: string): AccountRef => ({
  code: `platform:dispute_holds:${currency}`,
  type: 'liability',
  currency,
});

/** Signed ledger sum -> the balance in the account's natural direction. */
export function naturalBalance(type: AccountType, signedSum: number): number {
  return type === 'asset' || type === 'expense' ? signedSum : -signedSum;
}
