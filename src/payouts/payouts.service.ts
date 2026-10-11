import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PoolClient } from 'pg';
import { PAYOUT_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { payoutInitiatedLines, payoutReversedLines, payoutSettledLines } from '../ledger/entries';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { holdCutoff, payableAmount, SellerBalanceParts } from './payout-math';

interface PayoutRow {
  id: string;
  seller_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed';
  provider: string;
  provider_ref: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
}

const toView = (p: PayoutRow) => ({
  id: p.id,
  sellerId: p.seller_id,
  amount: p.amount,
  currency: p.currency.trim(),
  status: p.status,
  attempts: p.attempts,
  lastError: p.last_error,
  createdAt: p.created_at.toISOString(),
});

export interface BatchLine {
  sellerId: string;
  currency: string;
  matured: number;
  debits: number;
  reserve: number;
  payoutId?: string;
  payoutAmount?: number;
  skipped?: string;
}

const SELLER_CODE = /^seller:(.+):([A-Z]{3})$/;

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly providers: ProviderRegistry,
    @InjectQueue(PAYOUT_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Credits that cleared the hold period and all debits for one seller account. */
  async balanceParts(client: Pick<PoolClient, 'query'>, accountId: string, cutoff: Date): Promise<SellerBalanceParts> {
    const r = await client.query<{ matured: number; debits: number }>(
      `SELECT COALESCE(sum(-p.amount) FILTER (WHERE p.amount < 0 AND e.effective_at <= $2), 0) AS matured,
              COALESCE(sum(p.amount)  FILTER (WHERE p.amount > 0), 0) AS debits
         FROM postings p JOIN journal_entries e ON e.id = p.entry_id
        WHERE p.account_id = $1`,
      [accountId, cutoff],
    );
    return { maturedCredits: r.rows[0].matured, debits: r.rows[0].debits };
  }

  /** Daily job: turn each seller's available balance into a pending payout. */
  async runBatch(asOf: Date = new Date()): Promise<BatchLine[]> {
    const cutoff = holdCutoff(asOf, this.config.payoutHoldDays);
    const accounts = await this.db.query<{ id: string; code: string }>(
      "SELECT id, code FROM accounts WHERE code LIKE 'seller:%' ORDER BY code",
    );
    const lines: BatchLine[] = [];
    for (const acct of accounts.rows) {
      const m = SELLER_CODE.exec(acct.code);
      if (!m) continue;
      const [, sellerId, currency] = m;
      const { line, enqueue } = await this.db.tx(async (client) => {
        // Serialize concurrent batches for this seller: lock the cached balance row first.
        await client.query('SELECT 1 FROM account_balances WHERE account_id = $1 FOR UPDATE', [acct.id]);
        const parts = await this.balanceParts(client, acct.id, cutoff);
        const reserve = this.config.payoutReserveMinor;
        const payable = payableAmount(parts, reserve);
        const base = { sellerId, currency, matured: parts.maturedCredits, debits: parts.debits, reserve };
        if (payable < Math.max(1, this.config.payoutMinMinor)) {
          return { line: { ...base, skipped: payable === 0 ? 'nothing available (held, reserved or refunded)' : 'below minimum payout' }, enqueue: undefined };
        }
        const payout = await client.query<{ id: string }>(
          `INSERT INTO payouts (seller_id, amount, currency, status, provider) VALUES ($1,$2,$3,'pending',$4) RETURNING id`,
          [sellerId, payable, currency, this.config.defaultProvider],
        );
        const payoutId = payout.rows[0].id;
        await this.ledger.post(client, {
          kind: 'payout_initiated',
          referenceKey: `payout:${payoutId}:initiated`,
          payoutId,
          description: `Payout ${payable} to ${sellerId}`,
          lines: payoutInitiatedLines({ sellerId, currency, amount: payable }),
        });
        return { line: { ...base, payoutId, payoutAmount: payable }, enqueue: payoutId };
      });
      lines.push(line);
      if (enqueue) await this.enqueueDispatch(enqueue);
    }
    return lines;
  }

  enqueueDispatch(payoutId: string, delayMs = 0) {
    // One in-flight dispatch per (payout, attempt): the jobId makes enqueueing idempotent.
    return this.queue.add('dispatch', { payoutId }, { jobId: `dispatch-${payoutId}-${Date.now()}`, delay: delayMs });
  }

  /** Hand a pending payout to the provider. The outcome arrives later as a webhook. */
  async dispatch(payoutId: string): Promise<void> {
    await this.db.tx(async (client) => {
      const p = await this.lockPayout(client, payoutId);
      if (p.status !== 'pending' || p.provider_ref) return; // already final, or an attempt is in flight
      const attempt = p.attempts + 1;
      const { payoutRef } = await this.providers.get(p.provider).createPayout({
        payoutId,
        sellerId: p.seller_id,
        amount: p.amount,
        currency: p.currency.trim(),
        attempt,
      });
      await client.query('UPDATE payouts SET attempts = $2, provider_ref = $3, updated_at = now() WHERE id = $1', [payoutId, attempt, payoutRef]);
    });
  }

  /** Apply a provider's payout.paid / payout.failed webhook. Idempotent; stale events are ignored. */
  async applyProviderResult(payoutId: string, outcome: 'paid' | 'failed', info: { payoutRef?: string; reason?: string }): Promise<void> {
    const retryDelay = await this.db.tx(async (client) => {
      const p = await this.lockPayout(client, payoutId);
      if (p.status !== 'pending') return undefined; // already settled: duplicate delivery
      if (p.provider_ref && info.payoutRef && p.provider_ref !== info.payoutRef) {
        this.logger.warn(`Ignoring stale ${outcome} event for payout ${payoutId} (${info.payoutRef})`);
        return undefined;
      }
      const currency = p.currency.trim();
      if (outcome === 'paid') {
        await this.ledger.post(client, {
          kind: 'payout_settled',
          referenceKey: `payout:${payoutId}:settled`,
          externalRef: info.payoutRef ?? p.provider_ref ?? undefined,
          payoutId,
          description: `Payout ${payoutId} paid`,
          lines: payoutSettledLines({ currency, amount: p.amount }),
        });
        await client.query(`UPDATE payouts SET status = 'paid', updated_at = now() WHERE id = $1`, [payoutId]);
        return undefined;
      }
      if (p.attempts < this.config.payoutMaxAttempts) {
        // Retry: free the "in flight" marker and schedule another dispatch with exponential backoff.
        await client.query('UPDATE payouts SET provider_ref = NULL, last_error = $2, updated_at = now() WHERE id = $1', [payoutId, info.reason ?? 'failed']);
        return this.config.payoutRetryBackoffMs * 2 ** (p.attempts - 1);
      }
      await this.ledger.post(client, {
        kind: 'payout_reversed',
        referenceKey: `payout:${payoutId}:reversed`,
        externalRef: info.payoutRef,
        payoutId,
        description: `Payout ${payoutId} failed permanently; funds returned to ${p.seller_id}`,
        lines: payoutReversedLines({ sellerId: p.seller_id, currency, amount: p.amount }),
      });
      await client.query(`UPDATE payouts SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [payoutId, info.reason ?? 'failed']);
      return undefined;
    });
    if (retryDelay !== undefined) await this.enqueueDispatch(payoutId, retryDelay);
  }

  async get(id: string) {
    const r = await this.db.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payout ${id} not found`);
    return toView(r.rows[0]);
  }

  async list(sellerId?: string) {
    const r = await this.db.query<PayoutRow>(
      'SELECT * FROM payouts WHERE ($1::text IS NULL OR seller_id = $1) ORDER BY created_at DESC LIMIT 200',
      [sellerId ?? null],
    );
    return r.rows.map(toView);
  }

  async sellerBalance(sellerId: string, currency: string, asOf: Date = new Date()) {
    const code = `seller:${sellerId}:${currency}`;
    const acct = await this.db.query<{ id: string }>('SELECT id FROM accounts WHERE code = $1', [code]);
    const ledgerBalance = await this.ledger.balance(code);
    const reserve = this.config.payoutReserveMinor;
    const parts = acct.rows[0]
      ? await this.balanceParts(this.db.pool, acct.rows[0].id, holdCutoff(asOf, this.config.payoutHoldDays))
      : { maturedCredits: 0, debits: 0 };
    const available = payableAmount(parts, reserve);
    return {
      sellerId,
      currency,
      ledgerBalance,
      availableForPayout: available,
      heldOrReserved: Math.max(0, ledgerBalance - available),
      reserve,
      holdDays: this.config.payoutHoldDays,
    };
  }

  private async lockPayout(client: PoolClient, id: string): Promise<PayoutRow> {
    const r = await client.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payout ${id} not found`);
    return r.rows[0];
  }
}
