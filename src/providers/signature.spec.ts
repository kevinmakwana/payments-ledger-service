import { WebhookVerificationError } from './provider.interface';
import { hmacHex, signTimestamped, verifyPlainHmac, verifyTimestamped } from './signature';

const secret = 'whsec_test';
const body = Buffer.from('{"id":"evt_1","type":"payment.captured"}');
const now = 1_800_000_000;
const verify = (header: string | undefined, over: Partial<Parameters<typeof verifyTimestamped>[0]> = {}) =>
  verifyTimestamped({ header, body, secret, toleranceSeconds: 300, nowSeconds: now, ...over });

describe('webhook signatures', () => {
  it('accepts a correctly signed payload', () => {
    expect(verify(signTimestamped(secret, body, now))).toBe(now);
  });

  it('rejects a missing header', () => {
    expect(() => verify(undefined)).toThrow(expect.objectContaining({ code: 'missing_signature' }));
  });

  it('rejects a tampered body', () => {
    const header = signTimestamped(secret, body, now);
    expect(() => verify(header, { body: Buffer.from('{"id":"evt_1","type":"payout.paid"}') })).toThrow(
      expect.objectContaining({ code: 'invalid_signature' }),
    );
  });

  it('rejects a wrong secret and malformed headers', () => {
    expect(() => verify(signTimestamped('other', body, now))).toThrow(WebhookVerificationError);
    expect(() => verify('garbage')).toThrow(expect.objectContaining({ code: 'invalid_signature' }));
    expect(() => verify(`t=${now},v1=zz`)).toThrow(expect.objectContaining({ code: 'invalid_signature' }));
  });

  it('enforces the timestamp tolerance in both directions (replay protection)', () => {
    expect(() => verify(signTimestamped(secret, body, now - 301))).toThrow(expect.objectContaining({ code: 'stale_timestamp' }));
    expect(() => verify(signTimestamped(secret, body, now + 301))).toThrow(expect.objectContaining({ code: 'stale_timestamp' }));
    expect(verify(signTimestamped(secret, body, now - 300))).toBe(now - 300);
  });

  it('cannot reuse a signature with a changed timestamp', () => {
    const [, v1] = signTimestamped(secret, body, now).split(',');
    expect(() => verify(`t=${now - 10},${v1}`)).toThrow(expect.objectContaining({ code: 'invalid_signature' }));
  });

  it('plain HMAC scheme (Razorpay) verifies and rejects', () => {
    expect(() => verifyPlainHmac(hmacHex(secret, body), body, secret)).not.toThrow();
    expect(() => verifyPlainHmac(hmacHex('x', body), body, secret)).toThrow(WebhookVerificationError);
    expect(() => verifyPlainHmac(undefined, body, secret)).toThrow(WebhookVerificationError);
  });
});
