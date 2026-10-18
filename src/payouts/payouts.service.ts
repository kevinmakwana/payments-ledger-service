import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PoolClient } from 'pg';
import { PAYOUT_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AlertService } from '../alerts/alert.service';
import { DbService } from '../db/db.service';
import { payoutInitiatedLines, payoutReversedLines, payoutSettledLines } from '../ledger/entries';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { allocateAcrossProviders, holdCutoff, payableAmount, SellerBalanceParts } from './payout-math';

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
  /** Provider this leg is paid through (absent when the seller had nothing payable at all). */
  provider?: string;
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
    private readonly alerts: AlertService,
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

  /**
   * The same parts as `balanceParts`, split by the provider the money moved through: a sale or refund counts for the
   * provider of its payment, a payout for the provider that carried it. Ledger entries tied to neither (manual
   * adjustments) count for the default provider.
   */
  async balancePartsByProvider(client: Pick<PoolClient, 'query'>, accountId: string, cutoff: Date): Promise<Map<string, SellerBalanceParts>> {
    const r = await client.query<{ provider: string; matured: number; debits: number }>(
      `SELECT COALESCE(pa.provider, po.provider, $3) AS provider,
              COALESCE(sum(-p.amount) FILTER (WHERE p.amount < 0 AND e.effective_at <= $2), 0) AS matured,
              COALESCE(sum(p.amount)  FILTER (WHERE p.amount > 0), 0) AS debits
         FROM postings p
         JOIN journal_entries e ON e.id = p.entry_id
         LEFT JOIN payments pa ON pa.id = e.payment_id
         LEFT JOIN payouts po ON po.id = e.payout_id
        WHERE p.account_id = $1
        GROUP BY 1`,
      [accountId, cutoff, this.config.defaultProvider],
    );
    return new Map(r.rows.map((row) => [row.provider, { maturedCredits: row.matured, debits: row.debits }]));
  }

  /**
   * Daily job: turn each seller's available balance into pending payouts, one per provider that holds some of the
   * money. The seller-level total (matured credits - debits - one reserve) is unchanged; only the routing is split,
   * and a provider is never asked to pay out more than it took in for that seller.
   */
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
      const { sellerLines, enqueue } = await this.db.tx(async (client) => {
        // Serialize concurrent batches for this seller: lock the cached balance row first.
        await client.query('SELECT 1 FROM account_balances WHERE account_id = $1 FOR UPDATE', [acct.id]);
        const byProvider = await this.balancePartsByProvider(client, acct.id, cutoff);
        const parts = [...byProvider.values()].reduce(
          (a, b) => ({ maturedCredits: a.maturedCredits + b.maturedCredits, debits: a.debits + b.debits }),
          { maturedCredits: 0, debits: 0 },
        );
        const reserve = this.config.payoutReserveMinor;
        const payable = payableAmount(parts, reserve);
        const base = { sellerId, currency, matured: parts.maturedCredits, debits: parts.debits, reserve };
        if (payable < Math.max(1, this.config.payoutMinMinor)) {
          return {
            sellerLines: [{ ...base, skipped: payable === 0 ? 'nothing available (held, reserved or refunded)' : 'below minimum payout' }],
            enqueue: [] as string[],
          };
        }
        const caps = Object.fromEntries([...byProvider].map(([provider, p]) => [provider, p.maturedCredits - p.debits]));
        const sellerLines: BatchLine[] = [];
        const enqueue: string[] = [];
        for (const leg of allocateAcrossProviders(payable, caps)) {
          if (leg.amount < Math.max(1, this.config.payoutMinMinor)) {
            sellerLines.push({ ...base, provider: leg.provider, skipped: 'below minimum payout' }); // stays for a later run
            continue;
          }
          const payout = await client.query<{ id: string }>(
            `INSERT INTO payouts (seller_id, amount, currency, status, provider) VALUES ($1,$2,$3,'pending',$4) RETURNING id`,
            [sellerId, leg.amount, currency, leg.provider],
          );
          const payoutId = payout.rows[0].id;
          await this.ledger.post(client, {
            kind: 'payout_initiated',
            referenceKey: `payout:${payoutId}:initiated`,
            payoutId,
            description: `Payout ${leg.amount} to ${sellerId} via ${leg.provider}`,
            lines: payoutInitiatedLines({ sellerId, currency, amount: leg.amount }),
          });
          sellerLines.push({ ...base, provider: leg.provider, payoutId, payoutAmount: leg.amount });
          enqueue.push(payoutId);
        }
        return { sellerLines, enqueue };
      });
      lines.push(...sellerLines);
      for (const id of enqueue) await this.enqueueDispatch(id);
    }
    return lines;
  }

  enqueueDispatch(payoutId: string, delayMs = 0) {
    // A fresh id each time on purpose: BullMQ silently ignores an add whose id already exists (even a
    // finished or failed job), which would swallow a retry or a sweep. Duplicates are harmless:
    // dispatch() re-checks status and provider_ref under the payout row lock.
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

  /**
   * Safety net for payouts the happy path lost track of:
   *  - `pending` with no provider ref for longer than PAYOUT_STALE_MS: the batch committed but its
   *    dispatch job was never enqueued (or died). Re-dispatch. Rows are claimed atomically by bumping
   *    `updated_at`, so overlapping sweeps (or instances) never enqueue the same payout twice.
   *  - `pending` WITH a provider ref for longer than PAYOUT_AWAITING_PROVIDER_MS: the provider took
   *    the payout but never reported the outcome. Not re-dispatched (that could pay twice); alert a human.
   */
  async sweep(): Promise<{ redispatched: string[]; awaitingProvider: string[] }> {
    const staleBefore = new Date(Date.now() - this.config.payoutStaleMs);
    const claimed = await this.db.query<{ id: string }>(
      `UPDATE payouts SET updated_at = now()
        WHERE id IN (SELECT id FROM payouts
                      WHERE status = 'pending' AND provider_ref IS NULL AND updated_at < $1
                        FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [staleBefore],
    );
    const redispatched: string[] = [];
    for (const { id } of claimed.rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      try {
        await this.enqueueDispatch(id);
        redispatched.push(id);
      } catch (err) {
        // Already claimed, so it is retried after the next stale window; keep sweeping the others.
        this.logger.error(`Sweeper could not enqueue payout ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const silentBefore = new Date(Date.now() - this.config.payoutAwaitingProviderMs);
    const silent = await this.db.query<{ id: string }>(
      `SELECT id FROM payouts WHERE status = 'pending' AND provider_ref IS NOT NULL AND updated_at < $1 ORDER BY updated_at, id`,
      [silentBefore],
    );
    const awaitingProvider = silent.rows.map((r) => r.id);
    if (awaitingProvider.length > 0) {
      await this.alerts.raise({
        kind: 'payout_awaiting_provider',
        severity: 'critical',
        message: `${awaitingProvider.length} payout(s) were accepted by the provider but no result arrived within ${Math.round(this.config.payoutAwaitingProviderMs / 3_600_000)}h; check the provider dashboard before retrying`,
        details: { payoutIds: awaitingProvider.slice(0, 50), count: awaitingProvider.length },
      });
    }
    if (redispatched.length > 0) this.logger.warn(`Sweeper re-dispatched ${redispatched.length} stale payout(s)`);
    return { redispatched, awaitingProvider };
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
