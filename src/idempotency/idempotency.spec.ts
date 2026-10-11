import { hashRequest } from './idempotency.service';

describe('request hashing', () => {
  it('is independent of key order and ignores undefined fields', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1, e: undefined }));
  });

  it('differs when any value differs', () => {
    expect(hashRequest({ amount: 1000 })).not.toBe(hashRequest({ amount: 1001 }));
    expect(hashRequest({ amount: 1000 })).not.toBe(hashRequest({ amount: '1000' }));
    expect(hashRequest([1, 2])).not.toBe(hashRequest([2, 1]));
  });
});
