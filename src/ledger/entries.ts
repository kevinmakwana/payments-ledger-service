import { AccountRef, clearing, fees, payoutsInTransit, sellerPayable } from './accounts';

/** One side of a journal entry. amount > 0 is a debit, amount < 0 is a credit. */
export interface PostingLine {
  account: AccountRef;
  amount: number;
}

const debit = (account: AccountRef, amount: number): PostingLine => ({ account, amount });
const credit = (account: AccountRef, amount: number): PostingLine => ({ account, amount: -amount });
/** A 100% fee (or 100% fee refund) leaves a zero seller share; zero postings are not allowed. */
const nonZero = (lines: PostingLine[]): PostingLine[] => lines.filter((l) => l.amount !== 0);

/** Buyer's money is captured: platform holds it, seller is owed (amount - fee), platform earns fee. */
export function captureLines(p: { sellerId: string; currency: string; amount: number; fee: number }): PostingLine[] {
  return nonZero([
    debit(clearing(p.currency), p.amount),
    credit(sellerPayable(p.sellerId, p.currency), p.amount - p.fee),
    credit(fees(p.currency), p.fee),
  ]);
}

/** Money goes back to the buyer; the fee is returned pro rata, the seller bears the rest. */
export function refundLines(p: {
  sellerId: string;
  currency: string;
  amount: number;
  feeRefund: number;
}): PostingLine[] {
  return nonZero([
    credit(clearing(p.currency), p.amount),
    debit(sellerPayable(p.sellerId, p.currency), p.amount - p.feeRefund),
    debit(fees(p.currency), p.feeRefund),
  ]);
}

/** Seller balance is moved out of "payable" into "in transit" when a payout is created. */
export function payoutInitiatedLines(p: { sellerId: string; currency: string; amount: number }): PostingLine[] {
  return [debit(sellerPayable(p.sellerId, p.currency), p.amount), credit(payoutsInTransit(p.currency), p.amount)];
}

/** Provider confirmed the payout: cash leaves the platform's provider balance. */
export function payoutSettledLines(p: { currency: string; amount: number }): PostingLine[] {
  return [debit(payoutsInTransit(p.currency), p.amount), credit(clearing(p.currency), p.amount)];
}

/** Payout permanently failed: the money goes back to the seller. */
export function payoutReversedLines(p: { sellerId: string; currency: string; amount: number }): PostingLine[] {
  return [debit(payoutsInTransit(p.currency), p.amount), credit(sellerPayable(p.sellerId, p.currency), p.amount)];
}
