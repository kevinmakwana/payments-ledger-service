import { createHmac, timingSafeEqual } from 'crypto';
import { WebhookVerificationError } from './provider.interface';

export const hmacHex = (secret: string, data: string | Buffer): string =>
  createHmac('sha256', secret).update(data).digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

/** `t=<unix>,v1=<hmac>` over `<t>.<rawBody>` (same scheme Stripe uses). */
export function signTimestamped(secret: string, body: string | Buffer, timestamp: number): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body.toString()}`)}`;
}

export function verifyTimestamped(opts: {
  header: string | undefined;
  body: Buffer;
  secret: string;
  toleranceSeconds: number;
  nowSeconds: number;
}): number {
  if (!opts.header) throw new WebhookVerificationError('missing_signature', 'Missing signature header');
  const parts = opts.header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const candidates = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isInteger(t) || candidates.length === 0) {
    throw new WebhookVerificationError('invalid_signature', 'Malformed signature header');
  }
  const expected = hmacHex(opts.secret, `${t}.${opts.body.toString()}`);
  // Signature first: don't leak timing/tolerance information for forged requests.
  if (!candidates.some((c) => safeEqualHex(c, expected))) {
    throw new WebhookVerificationError('invalid_signature', 'Signature does not match payload');
  }
  assertWithinTolerance(t, opts.nowSeconds, opts.toleranceSeconds);
  return t;
}

/** Plain `hex(hmac(secret, body))` (Razorpay scheme). */
export function verifyPlainHmac(header: string | undefined, body: Buffer, secret: string): void {
  if (!header) throw new WebhookVerificationError('missing_signature', 'Missing signature header');
  if (!safeEqualHex(header, hmacHex(secret, body))) {
    throw new WebhookVerificationError('invalid_signature', 'Signature does not match payload');
  }
}

export function assertWithinTolerance(timestamp: number, nowSeconds: number, toleranceSeconds: number): void {
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError('stale_timestamp', 'Webhook timestamp outside tolerance');
  }
}

export const headerValue = (h: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
