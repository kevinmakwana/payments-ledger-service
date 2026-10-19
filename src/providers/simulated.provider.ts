import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import {
  AuthorizeRequest,
  PaymentProvider,
  ProviderRejectedError,
  ProviderTransaction,
  WebhookEvent,
  WebhookVerificationError,
} from './provider.interface';
import { headerValue, signTimestamped, verifyTimestamped } from './signature';

/** 24 hex chars derived from a key: stable ids for a given idempotency key. */
const stable = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/**
 * Offline provider. Behaves like a real one: keeps its own books (separate table from
 * our ledger) and delivers HMAC-signed webhooks to our own /webhooks/simulated endpoint.
 *
 * Failure simulation for payouts, keyed on the seller id:
 *   fail_*   always fails        flaky_*  fails on the first attempt only
 */
@Injectable()
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';
  private readonly logger = new Logger(SimulatedProvider.name);
  private baseUrl: string | undefined;
  /** Delay before a webhook is delivered, so it arrives after the API call returns (like production). */
  webhookDelayMs = 50;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
  ) {}

  /** Where to POST webhooks, e.g. http://127.0.0.1:3000. Set after the HTTP server is listening. */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, '');
  }

  /** Resolves when all in-flight webhook deliveries have been attempted (useful for tests/demo). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Results are derived deterministically from the idempotency key (like a real provider replaying a stored
   * response), and the books/webhook happen once, so re-executing a call is harmless.
   * A card is declined when the payment method is `pm_card_declined`.
   */
  async authorize(req: AuthorizeRequest): Promise<{ providerRef: string }> {
    if (req.paymentMethod === 'pm_card_declined') throw new ProviderRejectedError('card_declined', 'Your card was declined.');
    return { providerRef: `sim_ch_${stable(req.idempotencyKey)}` };
  }

  async capture(req: { paymentId: string; providerRef: string; amount: number; currency: string; idempotencyKey: string }) {
    if (await this.record(req.providerRef, 'charge', req.amount, req.currency)) {
      this.emit('payment.captured', { paymentId: req.paymentId, providerRef: req.providerRef, amount: req.amount });
    }
    return { reportedRef: req.providerRef };
  }

  async void(_req: { paymentId: string; providerRef: string; idempotencyKey: string }): Promise<void> {
    // Nothing to release in the simulator's books: an uncaptured authorization never moved money.
  }

  async refund(req: { refundId: string; providerRef: string; amount: number; currency: string; idempotencyKey: string }) {
    const refundRef = `sim_re_${stable(req.idempotencyKey)}`;
    if (await this.record(refundRef, 'refund', req.amount, req.currency, req.providerRef)) {
      this.emit('payment.refunded', { providerRef: req.providerRef, refundRef, amount: req.amount });
    }
    return { refundRef };
  }

  async createPayout(req: { payoutId: string; sellerId: string; amount: number; currency: string; attempt: number }) {
    const payoutRef = `sim_po_${stable(`${req.payoutId}:${req.attempt}`)}`;
    const fails = req.sellerId.startsWith('fail_') || (req.sellerId.startsWith('flaky_') && req.attempt === 1);
    if (fails) {
      this.emit('payout.failed', { payoutId: req.payoutId, payoutRef, reason: 'bank_account_rejected' });
    } else if (await this.record(payoutRef, 'payout', req.amount, req.currency)) {
      this.emit('payout.paid', { payoutId: req.payoutId, payoutRef, amount: req.amount });
    }
    return { payoutRef };
  }

  async listTransactions(date: string): Promise<ProviderTransaction[]> {
    const r = await this.db.query<{
      id: string;
      type: ProviderTransaction['type'];
      amount: number;
      currency: string;
      parent_ref: string | null;
      created_at: Date;
    }>(
      `SELECT * FROM sim_provider_transactions
        WHERE (created_at AT TIME ZONE 'UTC')::date = $1::date ORDER BY created_at, id`,
      [date],
    );
    return r.rows.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      currency: t.currency.trim(),
      parentRef: t.parent_ref ?? undefined,
      createdAt: t.created_at.toISOString(),
    }));
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, nowSeconds = Math.floor(Date.now() / 1000)): WebhookEvent {
    verifyTimestamped({
      header: headerValue(headers, 'x-signature'),
      body: rawBody,
      secret: this.config.simulatedWebhookSecret,
      toleranceSeconds: this.config.webhookToleranceSeconds,
      nowSeconds,
    });
    try {
      const e = JSON.parse(rawBody.toString()) as WebhookEvent;
      if (!e.id || !e.type || typeof e.createdAt !== 'number') throw new Error('missing fields');
      return e;
    } catch {
      throw new WebhookVerificationError('malformed_payload', 'Webhook body is not a valid event');
    }
  }

  /** Test/demo hooks: mutate the provider's books to create reconciliation mismatches. */
  async tamper(op: { remove?: string; setAmount?: { id: string; amount: number }; add?: ProviderTransaction }): Promise<void> {
    if (op.remove) await this.db.query('DELETE FROM sim_provider_transactions WHERE id = $1', [op.remove]);
    if (op.setAmount) {
      await this.db.query('UPDATE sim_provider_transactions SET amount = $2 WHERE id = $1', [op.setAmount.id, op.setAmount.amount]);
    }
    if (op.add) {
      await this.record(op.add.id, op.add.type, op.add.amount, op.add.currency, op.add.parentRef);
    }
  }

  /** Inserts into the provider's books once; returns false if this id was already recorded. */
  private async record(id: string, type: ProviderTransaction['type'], amount: number, currency: string, parentRef?: string): Promise<boolean> {
    const r = await this.db.query(
      'INSERT INTO sim_provider_transactions (id, type, amount, currency, parent_ref) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING',
      [id, type, amount, currency, parentRef ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  private emit(type: string, data: WebhookEvent['data']): void {
    const event: WebhookEvent = { id: `evt_${randomUUID()}`, type, createdAt: Math.floor(Date.now() / 1000), data };
    const job: Promise<void> = this.deliver(event).then(
      () => undefined,
      (err) => this.logger.warn(`Webhook delivery failed: ${err}`),
    );
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** POST the signed event to our own endpoint. Public so tests can replay/duplicate deliveries. */
  async deliver(event: WebhookEvent, opts: { timestamp?: number } = {}): Promise<Response | undefined> {
    if (!this.baseUrl) {
      this.logger.warn(`No webhook base URL set; dropping ${event.type}`);
      return undefined;
    }
    await new Promise((r) => setTimeout(r, this.webhookDelayMs));
    const body = JSON.stringify(event);
    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
    return fetch(`${this.baseUrl}/webhooks/simulated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signTimestamped(this.config.simulatedWebhookSecret, body, ts) },
      body,
    });
  }
}
