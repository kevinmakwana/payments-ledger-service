import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import {
  AuthorizeRequest,
  PaymentProvider,
  ProviderRejectedError,
  ProviderTransaction,
  WebhookEvent,
  WebhookVerificationError,
} from './provider.interface';
import { MAX_LIST_PAGES, ProviderResponse, providerRequest } from './http';
import { headerValue, verifyTimestamped } from './signature';

/**
 * Stripe Connect driver (separate charges and transfers). Same interface as the simulator;
 * needs STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET. Not exercised in CI (no keys there).
 * Sellers are Connect account ids (acct_...), payouts are Transfers to them.
 */
@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.stripeSecretKey && this.config.stripeWebhookSecret);
  }

  async authorize(req: AuthorizeRequest) {
    const pi = await this.post('/payment_intents', {
      amount: req.amount,
      currency: req.currency.toLowerCase(),
      capture_method: 'manual',
      confirm: true,
      payment_method: req.paymentMethod ?? 'pm_card_visa',
      'automatic_payment_methods[enabled]': true,
      'automatic_payment_methods[allow_redirects]': 'never',
      'metadata[payment_id]': req.paymentId,
    }, req.idempotencyKey);
    return { providerRef: pi.id as string };
  }

  async capture(req: Parameters<PaymentProvider['capture']>[0]) {
    const pi = await this.post(`/payment_intents/${req.providerRef}/capture`, { amount_to_capture: req.amount }, req.idempotencyKey);
    return { reportedRef: pi.latest_charge as string };
  }

  async void(req: { paymentId: string; providerRef: string; idempotencyKey: string }): Promise<void> {
    await this.post(`/payment_intents/${req.providerRef}/cancel`, {}, req.idempotencyKey);
  }

  async refund(req: Parameters<PaymentProvider['refund']>[0]) {
    const r = await this.post('/refunds', { payment_intent: req.providerRef, amount: req.amount, 'metadata[refund_id]': req.refundId }, req.idempotencyKey);
    return { refundRef: r.id as string };
  }

  async createPayout(req: { payoutId: string; sellerId: string; amount: number; currency: string; attempt: number }) {
    const t = await this.post('/transfers', {
      amount: req.amount,
      currency: req.currency.toLowerCase(),
      destination: req.sellerId,
      'metadata[payout_id]': req.payoutId,
    }, `po_${req.payoutId}_${req.attempt}`); // per attempt: Stripe replays the saved result of a reused key, even a failed one
    return { payoutRef: t.id as string };
  }

  async listTransactions(date: string): Promise<ProviderTransaction[]> {
    const start = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const kinds: Record<string, ProviderTransaction['type']> = { charge: 'charge', payment: 'charge', refund: 'refund', transfer: 'payout' };
    const out: ProviderTransaction[] = [];
    let startingAfter: string | undefined;
    // Cursor pagination: a page holds at most 100 objects, `has_more` says whether another follows.
    for (let page = 1; ; page++) {
      if (page > MAX_LIST_PAGES) throw new Error(`Stripe returned more than ${MAX_LIST_PAGES} pages of balance transactions for ${date}`);
      const q = new URLSearchParams({ 'created[gte]': String(start), 'created[lt]': String(start + 86400), limit: '100' });
      if (startingAfter) q.set('starting_after', startingAfter);
      const res = await this.get(`/balance_transactions?${q}`);
      const data = res.data as Record<string, any>[];
      for (const t of data) {
        if (!kinds[t.type]) continue;
        out.push({
          id: t.source as string,
          type: kinds[t.type],
          amount: Math.abs(t.amount as number),
          currency: String(t.currency).toUpperCase(),
          createdAt: new Date((t.created as number) * 1000).toISOString(),
        });
      }
      if (!res.has_more || data.length === 0) return out;
      startingAfter = data[data.length - 1].id as string;
    }
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, nowSeconds = Math.floor(Date.now() / 1000)): WebhookEvent {
    verifyTimestamped({
      header: headerValue(headers, 'stripe-signature'),
      body: rawBody,
      secret: this.config.stripeWebhookSecret ?? '',
      toleranceSeconds: this.config.webhookToleranceSeconds,
      nowSeconds,
    });
    try {
      const e = JSON.parse(rawBody.toString());
      const o = e.data?.object ?? {};
      const base = { id: e.id as string, createdAt: e.created as number };
      switch (e.type) {
        case 'charge.captured':
          return { ...base, type: 'payment.captured', data: { providerRef: o.payment_intent, paymentId: o.metadata?.payment_id, amount: o.amount_captured } };
        case 'refund.created':
          return { ...base, type: 'payment.refunded', data: { providerRef: o.payment_intent, refundRef: o.id, amount: o.amount } };
        case 'charge.dispute.created':
        case 'charge.dispute.closed': {
          // `warning_*` statuses are inquiries: the bank asked a question but withdrew no funds, so nothing may hit the ledger.
          const status = String(o.status ?? '');
          const data = { disputeRef: o.id, providerRef: o.payment_intent, amount: o.amount, currency: String(o.currency ?? '').toUpperCase(), reason: o.reason };
          if (status.startsWith('warning_')) return { ...base, type: 'dispute.inquiry', data };
          if (e.type === 'charge.dispute.created') return { ...base, type: 'dispute.opened', data };
          if (status === 'won') return { ...base, type: 'dispute.won', data };
          if (status === 'lost') return { ...base, type: 'dispute.lost', data };
          return { ...base, type: `dispute.${status || 'closed'}`, data }; // expired etc.: stored, not acted on
        }
        case 'payment_intent.payment_failed':
          return { ...base, type: 'payment.failed', data: { providerRef: o.id, paymentId: o.metadata?.payment_id, reason: o.last_payment_error?.message } };
        case 'transfer.created':
          return { ...base, type: 'payout.paid', data: { payoutId: o.metadata?.payout_id, payoutRef: o.id, amount: o.amount } };
        case 'transfer.reversed':
          return { ...base, type: 'payout.failed', data: { payoutId: o.metadata?.payout_id, payoutRef: o.id, reason: 'transfer_reversed' } };
        default:
          return { ...base, type: e.type, data: {} };
      }
    } catch {
      throw new WebhookVerificationError('malformed_payload', 'Webhook body is not a valid Stripe event');
    }
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    if (!this.config.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured');
    return {
      authorization: `Bearer ${this.config.stripeSecretKey}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    };
  }

  private async post(path: string, form: Record<string, string | number | boolean>, idempotencyKey: string) {
    const body = new URLSearchParams(Object.entries(form).map(([k, v]): [string, string] => [k, String(v)]));
    return this.handle(await providerRequest(this.name, this.config.stripeApiBase + path, { method: 'POST', headers: this.headers(idempotencyKey), body }, this.config.providerTimeoutMs));
  }

  private async get(path: string) {
    return this.handle(await providerRequest(this.name, this.config.stripeApiBase + path, { headers: this.headers() }, this.config.providerTimeoutMs));
  }

  /**
   * Definitive refusals (declined card, invalid request, unknown resource) become ProviderRejectedError. Anything whose
   * outcome is unknown or operational stays a plain Error so it is retried rather than shown as a decline: 5xx and
   * `api_error`, 429, 408, 409 (same-key request still in flight) and 401/403 (our credentials, not the customer's card).
   */
  private handle(res: ProviderResponse): Record<string, any> {
    if (res.ok) return res.json;
    const e = res.json.error ?? {};
    const message = e.message ?? 'request failed';
    const retryable = res.status >= 500 || [401, 403, 408, 409, 429].includes(res.status);
    if (!retryable && ['card_error', 'invalid_request_error', 'idempotency_error'].includes(e.type)) {
      throw new ProviderRejectedError(e.code ?? e.type, message);
    }
    throw new Error(`Stripe ${res.status}: ${message}`);
  }
}
