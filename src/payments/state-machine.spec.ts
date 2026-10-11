import { IllegalTransitionError } from '../common/errors';
import { assertTransition, canTransition, PaymentStatus, statusAfterRefund } from './state-machine';

const ALL: PaymentStatus[] = ['created', 'authorized', 'captured', 'partially_refunded', 'refunded'];

describe('payment state machine', () => {
  const legal: [PaymentStatus, PaymentStatus][] = [
    ['created', 'authorized'],
    ['authorized', 'captured'],
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

  it('refunded is terminal; double capture and capture-before-authorize are illegal', () => {
    for (const to of ALL) expect(canTransition('refunded', to)).toBe(false);
    expect(canTransition('captured', 'captured')).toBe(false);
    expect(canTransition('created', 'captured')).toBe(false);
    expect(canTransition('authorized', 'refunded')).toBe(false);
  });

  it('picks the refund status from cumulative refunded amount', () => {
    expect(statusAfterRefund(100, 30)).toBe('partially_refunded');
    expect(statusAfterRefund(100, 100)).toBe('refunded');
  });
});
