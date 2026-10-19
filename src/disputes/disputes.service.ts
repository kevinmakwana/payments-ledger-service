import { Injectable } from '@nestjs/common';
import { RetryableWebhookError } from '../common/errors';
import { cumulativeFeeRefund } from '../common/money';
import { decodeCursor, isPgTimestamp, isUuid, Page, pageOf, resolveLimit, Where } from '../common/pagination';
import { DbService } from '../db/db.service';
import { disputeLostLines, disputeOpenedLines, disputeWonLines } from '../ledger/entries';
import { LedgerService } from '../ledger/ledger.service';
import { WebhookEvent } from '../providers/provider.interface';

interface DisputeRow {
  id: string;
  payment_id: string;
  amount: number;
  fee_part: number;
  currency: string;
  status: 'open' | 'won' | 'lost';
}

/**
 * Chargebacks as ledger events. Both operations are idempotent (the provider's dispute id is unique and every ledger
 * entry has a reference key), and both throw RetryableWebhookError for "not yet" conditions so out-of-order or early
 * events are simply retried by the webhook queue.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
  ) {}

  async list(q: { limit?: number; cursor?: string; status?: string; paymentId?: string; provider?: string }): Promise<Page<Record<string, unknown>>> {
    const limit = resolveLimit(q.limit);
    const cursor = decodeCursor<{ t: string; i: string }>(q.cursor, { t: 'string', i: 'string' }, (c) => isPgTimestamp(c.t) && isUuid(c.i));
    const w = new Where();
    if (q.status) w.add('status = ?', q.status);
    if (q.paymentId) w.add('payment_id = ?::uuid', q.paymentId);
    if (q.provider) w.add('provider = ?', q.provider);
    if (cursor) w.addMany('(opened_at, id) < (?1::timestamptz, ?2::uuid)', [cursor.t, cursor.i]);
    const r = await this.db.query<DisputeRow & { provider: string; provider_ref: string; reason: string | null; opened_at: Date; resolved_at: Date | null; cursor_ts: string }>(
      `SELECT *, opened_at::text AS cursor_ts FROM disputes ${w.sql} ORDER BY opened_at DESC, id DESC LIMIT ${w.param(limit + 1)}`,
      w.params,
    );
    const page = pageOf(r.rows, limit, (row) => ({ t: row.cursor_ts, i: row.id }));
    return {
      data: page.data.map((d) => ({
        id: d.id,
        paymentId: d.payment_id,
        provider: d.provider,
        providerRef: d.provider_ref,
        amount: d.amount,
        currency: d.currency.trim(),
        status: d.status,
        reason: d.reason,
        openedAt: d.opened_at.toISOString(),
        resolvedAt: d.resolved_at?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async open(provider: string, event: WebhookEvent): Promise<void> {
    const { disputeRef, providerRef, amount: eventAmount, reason } = event.data;
    if (!disputeRef || !providerRef) throw new Error('dispute event without dispute or payment reference');
    await this.db.tx(async (client) => {
      const found = await client.query<{ id: string; seller_id: string; amount: number; fee_amount: number; currency: string; status: string }>(
        'SELECT id, seller_id, amount, fee_amount, currency, status FROM payments WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
        [provider, providerRef],
      );
      const p = found.rows[0];
      if (!p) throw new RetryableWebhookError(`No payment with ${provider} reference ${providerRef} yet`);
      if (!['captured', 'partially_refunded', 'refunded'].includes(p.status)) {
        throw new RetryableWebhookError(`Payment ${p.id} is ${p.status}, not captured yet`);
      }
      const existing = await client.query('SELECT 1 FROM disputes WHERE provider = $1 AND provider_ref = $2', [provider, disputeRef]);
      if (existing.rowCount) return; // duplicate delivery
      const amount = eventAmount ?? p.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > p.amount) {
        throw new Error(`Dispute ${disputeRef} amount ${amount} is not within the payment amount ${p.amount}`);
      }
      const currency = p.currency.trim();
      const feePart = cumulativeFeeRefund(p.fee_amount, p.amount, amount);
      const created = await client.query<{ id: string }>(
        `INSERT INTO disputes (payment_id, provider, provider_ref, amount, currency, fee_part, status, reason)
         VALUES ($1,$2,$3,$4,$5,$6,'open',$7) RETURNING id`,
        [p.id, provider, disputeRef, amount, currency, feePart, reason ?? null],
      );
      await this.ledger.post(client, {
        kind: 'dispute_opened',
        referenceKey: `dispute:${created.rows[0].id}:opened`,
        paymentId: p.id,
        description: `Dispute ${disputeRef} opened on payment ${p.id}`,
        lines: disputeOpenedLines({ sellerId: p.seller_id, currency, amount, feePart }),
      });
    });
  }

  async resolve(provider: string, event: WebhookEvent, outcome: 'won' | 'lost'): Promise<void> {
    const { disputeRef } = event.data;
    if (!disputeRef) throw new Error('dispute event without dispute reference');
    await this.db.tx(async (client) => {
      const found = await client.query<DisputeRow>('SELECT * FROM disputes WHERE provider = $1 AND provider_ref = $2 FOR UPDATE', [provider, disputeRef]);
      const d = found.rows[0];
      if (!d) throw new RetryableWebhookError(`Dispute ${disputeRef} has not been recorded yet`);
      if (d.status !== 'open') return; // already resolved: duplicate delivery
      const seller = await client.query<{ seller_id: string }>('SELECT seller_id FROM payments WHERE id = $1', [d.payment_id]);
      const parts = { sellerId: seller.rows[0].seller_id, currency: d.currency.trim(), amount: d.amount, feePart: d.fee_part };
      await this.ledger.post(client, {
        kind: `dispute_${outcome}`,
        referenceKey: `dispute:${d.id}:${outcome}`,
        paymentId: d.payment_id,
        description: `Dispute ${disputeRef} ${outcome}`,
        lines: outcome === 'won' ? disputeWonLines(parts) : disputeLostLines(parts),
      });
      await client.query('UPDATE disputes SET status = $2, resolved_at = now() WHERE id = $1', [d.id, outcome]);
    });
  }
}
