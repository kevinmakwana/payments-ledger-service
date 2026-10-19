import { IllegalTransitionError } from '../common/errors';

/**
 * created -> authorized -> capturing -> captured -> partially_refunded -> refunded
 *   |            |  ^          |
 *   v            |  +----------+ (capture declined)
 * failed         v
 *            voiding -> voided | expired        (voiding -> authorized if the provider refuses)
 *
 * `created`, `capturing` and `voiding` are in-flight: a provider call is pending or being retried.
 */
export type PaymentStatus =
  | 'created'
  | 'authorized'
  | 'capturing'
  | 'captured'
  | 'partially_refunded'
  | 'refunded'
  | 'failed'
  | 'voiding'
  | 'voided'
  | 'expired';

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'created', 'authorized', 'capturing', 'captured', 'partially_refunded', 'refunded', 'failed', 'voiding', 'voided', 'expired',
];

const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['authorized', 'failed'],
  authorized: ['capturing', 'voiding', 'failed'], // `failed`: the provider reported the authorization as failed
  capturing: ['captured', 'authorized'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
  failed: [],
  voiding: ['voided', 'expired', 'authorized'],
  voided: [],
  expired: [],
};

const IN_FLIGHT: readonly PaymentStatus[] = ['created', 'capturing', 'voiding'];

/** True while a provider call for this payment is pending or being retried (the recovery worker watches these). */
export function isInFlight(status: PaymentStatus): boolean {
  return IN_FLIGHT.includes(status);
}

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
