import { IllegalTransitionError } from '../common/errors';

export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'partially_refunded' | 'refunded';

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['authorized'],
  authorized: ['captured'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** The state a payment lands in after `refundedTotal` of `captured` has been refunded. */
export function statusAfterRefund(captured: number, refundedTotal: number): 'partially_refunded' | 'refunded' {
  return refundedTotal >= captured ? 'refunded' : 'partially_refunded';
}
