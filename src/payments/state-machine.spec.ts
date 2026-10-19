import { IllegalTransitionError } from '../common/errors';
import { assertTransition, canTransition, isInFlight, PaymentStatus, statusAfterRefund } from './state-machine';

const ALL: PaymentStatus[] = [
  'created', 'authorized', 'capturing', 'captured', 'partially_refunded', 'refunded', 'failed', 'voiding', 'voided', 'expired',
];

describe('payment state machine', () => {
  const legal: [PaymentStatus, PaymentStatus][] = [
    ['created', 'authorized'],
    ['created', 'failed'], // authorization declined
    ['authorized', 'failed'], // the provider later reports the authorization as failed
    ['authorized', 'capturing'],
    ['capturing', 'captured'],
    ['capturing', 'authorized'], // capture declined: the authorization is still good
    ['authorized', 'voiding'],
    ['voiding', 'voided'],
    ['voiding', 'expired'],
    ['voiding', 'authorized'], // void rejected by the provider
    ['captured', 'partially_refunded'],
    ['captured', 'refunded'],
    ['partially_refunded', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every other transition', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (legal.some(([f, t]) => f === from && t === to)) continue;
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
      }
    }
  });

  it('refunded, failed, voided and expired are terminal', () => {
    for (const terminal of ['refunded', 'failed', 'voided', 'expired'] as const) {
      for (const to of ALL) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it('double capture, capture-before-authorize and refunding an uncaptured payment are illegal', () => {
    expect(canTransition('captured', 'captured')).toBe(false);
    expect(canTransition('capturing', 'capturing')).toBe(false); // a second capture while one is in flight
    expect(canTransition('created', 'captured')).toBe(false);
    expect(canTransition('authorized', 'refunded')).toBe(false);
    expect(canTransition('authorized', 'captured')).toBe(false); // must go through `capturing`
  });

  it('cannot void once captured, and cannot capture a payment that is being voided', () => {
    expect(canTransition('captured', 'voiding')).toBe(false);
    expect(canTransition('voiding', 'capturing')).toBe(false);
  });

  it('knows which states have a provider call in flight', () => {
    expect([...ALL].filter(isInFlight)).toEqual(['created', 'capturing', 'voiding']);
  });

  it('picks the refund status from cumulative refunded amount', () => {
    expect(statusAfterRefund(100, 30)).toBe('partially_refunded');
    expect(statusAfterRefund(100, 100)).toBe('refunded');
  });
});
