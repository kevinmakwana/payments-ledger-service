import { AccountRef, clearing, disputedFunds, disputeHolds, fees, payoutsInTransit, sellerPayable } from './accounts';

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

interface DisputeParts {
  sellerId: string;
  currency: string;
  /** Disputed amount the provider withdrew. */
  amount: number;
  /** The platform fee that corresponds to the disputed amount (pro rata); the seller's share is the rest. */
  feePart: number;
}

/**
 * The provider withdrew the disputed amount from our balance. We may win it back, so it is parked in "disputed
 * funds" (a receivable), and the seller's share is withheld from their payable balance into the hold account so it
 * cannot be paid out meanwhile. The platform's fee share stays in revenue until the outcome is known.
 */
export function disputeOpenedLines(p: DisputeParts): PostingLine[] {
  const sellerShare = p.amount - p.feePart;
  return nonZero([
    debit(disputedFunds(p.currency), p.amount),
    credit(clearing(p.currency), p.amount),
    debit(sellerPayable(p.sellerId, p.currency), sellerShare),
    credit(disputeHolds(p.currency), sellerShare),
  ]);
}

/** Dispute won: the provider returns the money and the seller's withheld share is released. Exactly undoes the opening. */
export function disputeWonLines(p: DisputeParts): PostingLine[] {
  const sellerShare = p.amount - p.feePart;
  return nonZero([
    debit(clearing(p.currency), p.amount),
    credit(disputedFunds(p.currency), p.amount),
    debit(disputeHolds(p.currency), sellerShare),
    credit(sellerPayable(p.sellerId, p.currency), sellerShare),
  ]);
}

/**
 * Dispute lost: the receivable is written off. The seller keeps bearing their share (the hold is consumed) and the
 * platform returns its fee share. Together with the opening this is exactly the effect of a refund.
 */
export function disputeLostLines(p: DisputeParts): PostingLine[] {
  const sellerShare = p.amount - p.feePart;
  return nonZero([
    credit(disputedFunds(p.currency), p.amount),
    debit(disputeHolds(p.currency), sellerShare),
    debit(fees(p.currency), p.feePart),
  ]);
}

