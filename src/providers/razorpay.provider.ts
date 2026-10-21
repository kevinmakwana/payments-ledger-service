import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import {
  AuthorizeRequest,
  PaymentProvider,
  ProviderRejectedError,
  ProviderTransaction,
  WebhookEvent,
  WebhookVerificationError,
} from './provider.interface';
import { MAX_LIST_PAGES, minorUnits, providerRequest } from './http';
import { assertWithinTolerance, headerValue, verifyPlainHmac } from './signature';

/**
 * Razorpay driver. The buyer pays in Checkout, so `paymentMethod` carries the resulting
 * razorpay payment id (pay_...), which `authorize` verifies is in the `authorized` state.
 * Payouts use RazorpayX (sellerId = fund account id). Needs RAZORPAY_* env vars; not
 * exercised in CI (no keys there).
 */
@Injectable()
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.razorpayKeyId && this.config.razorpayKeySecret && this.config.razorpayWebhookSecret);
  }

  async authorize(req: AuthorizeRequest) {
    if (!req.paymentMethod) throw new Error('Razorpay requires paymentMethod = razorpay payment id');
    const p = await this.call('GET', `/payments/${req.paymentMethod}`);
    if (p.status !== 'authorized' || p.amount !== req.amount || p.currency !== req.currency) {
      throw new Error(`Razorpay payment ${p.id} is ${p.status} (${p.amount} ${p.currency}); expected authorized ${req.amount} ${req.currency}`);
    }
    return { providerRef: p.id as string };
  }

  async capture(req: Parameters<PaymentProvider['capture']>[0]) {
    const p = await this.call('POST', `/payments/${req.providerRef}/capture`, { amount: req.amount, currency: req.currency });
    return { reportedRef: req.providerRef, fee: minorUnits(p.fee) };
  }

  /** Razorpay has no cancel API: an uncaptured authorization is released automatically, so this is a definitive refusal. */
  async void(_req: { paymentId: string; providerRef: string; idempotencyKey: string }): Promise<void> {
    throw new ProviderRejectedError('void_not_supported', 'Razorpay releases uncaptured authorizations automatically; they cannot be voided via the API');
  }

  async refund(req: Parameters<PaymentProvider['refund']>[0]) {
    const r = await this.call('POST', `/payments/${req.providerRef}/refund`, { amount: req.amount, receipt: req.refundId });
    return { refundRef: r.id as string };
  }

  async createPayout(req: { payoutId: string; sellerId: string; amount: number; currency: string; attempt: number }) {
    const r = await this.call('POST', '/payouts', {
      account_number: process.env.RAZORPAY_X_ACCOUNT_NUMBER,
      fund_account_id: req.sellerId,
      amount: req.amount,
      currency: req.currency,
      mode: 'IMPS',
      purpose: 'payout',
      reference_id: req.payoutId,
    }, {
      // Mandatory since 15 Mar 2025. 4-36 chars of [A-Za-z0-9_- ], so a UUID + attempt will not fit: hash it.
      // Per attempt for the same reason as Stripe (a reused key replays the earlier result); stable within an attempt.
      'X-Payout-Idempotency': createHash('sha256').update(`${req.payoutId}:${req.attempt}`).digest('hex').slice(0, 32),
    });
    return { payoutRef: r.id as string };
  }

  async listTransactions(date: string): Promise<ProviderTransaction[]> {
    const from = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const range = `from=${from}&to=${from + 86399}`;
    const [payments, refunds] = await Promise.all([this.listAll('/payments', range), this.listAll('/refunds', range)]);
    return [
      ...payments.filter((p) => p.captured).map((p) => ({ id: p.id, type: 'charge' as const, amount: p.amount, currency: p.currency, createdAt: new Date(p.created_at * 1000).toISOString(), fee: minorUnits(p.fee) })),
      ...refunds.map((r) => ({ id: r.id, type: 'refund' as const, amount: r.amount, currency: r.currency, parentRef: r.payment_id, createdAt: new Date(r.created_at * 1000).toISOString() })),
    ];
  }

  /** Offset pagination: keep requesting `count`-sized pages until one comes back short. */
  private async listAll(path: string, query: string): Promise<Record<string, any>[]> {
    const count = 100;
    const items: Record<string, any>[] = [];
    for (let page = 0; ; page++) {
      if (page >= MAX_LIST_PAGES) throw new Error(`Razorpay returned more than ${MAX_LIST_PAGES} pages for ${path}?${query}`);
      const res = await this.call('GET', `${path}?${query}&count=${count}&skip=${page * count}`);
      const batch = res.items as Record<string, any>[];
      items.push(...batch);
      if (batch.length < count) return items;
    }
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, nowSeconds = Math.floor(Date.now() / 1000)): WebhookEvent {
    verifyPlainHmac(headerValue(headers, 'x-razorpay-signature'), rawBody, this.config.razorpayWebhookSecret ?? '');
    let e: Record<string, any>;
    try {
      e = JSON.parse(rawBody.toString());
    } catch {
      throw new WebhookVerificationError('malformed_payload', 'Webhook body is not valid JSON');
    }
    // Razorpay doesn't sign a timestamp, so tolerance applies to the event's own created_at.
    assertWithinTolerance(Number(e.created_at), nowSeconds, this.config.webhookToleranceSeconds);
    const id = headerValue(headers, 'x-razorpay-event-id');
    if (!id) throw new WebhookVerificationError('malformed_payload', 'Missing x-razorpay-event-id');
    const base = { id, createdAt: Number(e.created_at) };
    const p = e.payload?.payment?.entity ?? {};
    const r = e.payload?.refund?.entity ?? {};
    const po = e.payload?.payout?.entity ?? {};
    switch (e.event) {
      case 'payment.captured':
        return { ...base, type: 'payment.captured', data: { providerRef: p.id, paymentId: p.notes?.payment_id, amount: p.amount } };
      case 'payment.dispute.created':
      case 'payment.dispute.won':
      case 'payment.dispute.lost': {
        const d = e.payload?.dispute?.entity ?? {};
        const type = e.event === 'payment.dispute.created' ? 'dispute.opened' : e.event === 'payment.dispute.won' ? 'dispute.won' : 'dispute.lost';
        return { ...base, type, data: { disputeRef: d.id, providerRef: d.payment_id, amount: d.amount, currency: d.currency, reason: d.reason_code } };
      }
      case 'payment.failed':
        return { ...base, type: 'payment.failed', data: { providerRef: p.id, paymentId: p.notes?.payment_id, reason: p.error_description } };
      case 'refund.processed':
        return { ...base, type: 'payment.refunded', data: { providerRef: r.payment_id, refundRef: r.id, amount: r.amount } };
      case 'payout.processed':
        return { ...base, type: 'payout.paid', data: { payoutId: po.reference_id, payoutRef: po.id, amount: po.amount } };
      case 'payout.failed':
      case 'payout.reversed':
        return { ...base, type: 'payout.failed', data: { payoutId: po.reference_id, payoutRef: po.id, reason: po.failure_reason ?? e.event } };
      default:
        return { ...base, type: e.event, data: {} };
    }
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<Record<string, any>> {
    const { razorpayKeyId, razorpayKeySecret } = this.config;
    if (!razorpayKeyId || !razorpayKeySecret) throw new Error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured');
    const res = await providerRequest(
      this.name,
      this.config.razorpayApiBase + path,
      {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      this.config.providerTimeoutMs,
    );
    if (!res.ok) {
      const e = res.json.error ?? {};
      const message = e.description ?? 'request failed';
      // 400 BAD_REQUEST_ERROR cannot succeed on retry; gateway/server errors, 429 and 401 are retried or operational.
      if (res.status === 400 && e.code === 'BAD_REQUEST_ERROR') throw new ProviderRejectedError(e.code, message);
      throw new Error(`Razorpay ${res.status}: ${message}`);
    }
    return res.json;
  }
}
