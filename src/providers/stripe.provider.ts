import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import {
  AuthorizeRequest,
  PaymentProvider,
  ProviderTransaction,
  WebhookEvent,
  WebhookVerificationError,
} from './provider.interface';
import { headerValue, verifyTimestamped } from './signature';

const API = 'https://api.stripe.com/v1';

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

  async capture(req: { paymentId: string; providerRef: string; amount: number }) {
    const pi = await this.post(`/payment_intents/${req.providerRef}/capture`, { amount_to_capture: req.amount }, `cap_${req.paymentId}`);
    return { reportedRef: pi.latest_charge as string };
  }

  async refund(req: { refundId: string; providerRef: string; amount: number }) {
    const r = await this.post('/refunds', { payment_intent: req.providerRef, amount: req.amount, 'metadata[refund_id]': req.refundId }, `ref_${req.refundId}`);
    return { refundRef: r.id as string };
  }

  async createPayout(req: { payoutId: string; sellerId: string; amount: number; currency: string }) {
    const t = await this.post('/transfers', {
      amount: req.amount,
      currency: req.currency.toLowerCase(),
      destination: req.sellerId,
      'metadata[payout_id]': req.payoutId,
    }, `po_${req.payoutId}`);
    return { payoutRef: t.id as string };
  }

  async listTransactions(date: string): Promise<ProviderTransaction[]> {
    const start = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const q = new URLSearchParams({ 'created[gte]': String(start), 'created[lt]': String(start + 86400), limit: '100' });
    const res = await this.get(`/balance_transactions?${q}`);
    const kinds: Record<string, ProviderTransaction['type']> = { charge: 'charge', payment: 'charge', refund: 'refund', transfer: 'payout' };
    return (res.data as Record<string, any>[])
      .filter((t) => kinds[t.type])
      .map((t) => ({
        id: t.source as string,
        type: kinds[t.type],
        amount: Math.abs(t.amount as number),
        currency: String(t.currency).toUpperCase(),
        createdAt: new Date((t.created as number) * 1000).toISOString(),
      }));
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
    return this.handle(await fetch(API + path, { method: 'POST', headers: this.headers(idempotencyKey), body }));
  }

  private async get(path: string) {
    return this.handle(await fetch(API + path, { headers: this.headers() }));
  }

  private async handle(res: Response): Promise<Record<string, any>> {
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${json.error?.message ?? 'request failed'}`);
    return json;
  }
}
