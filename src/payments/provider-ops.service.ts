import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { MetricsService } from '../observability/metrics.service';
import { ProviderRejectedError } from '../providers/provider.interface';
import { withSpan } from '../observability/spans';
import { ProviderRegistry } from '../providers/provider.registry';

export type OpKind = 'authorize' | 'capture' | 'refund' | 'void';
export type OpStatus = 'pending' | 'in_flight' | 'succeeded' | 'failed';

export interface OpRow {
  id: string;
  payment_id: string;
  refund_id: string | null;
  kind: OpKind;
  provider: string;
  idempotency_key: string;
  request: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  status: OpStatus;
  result: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  claimed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** What the provider said: a result, or a definitive refusal. (Unknown outcomes never become an Outcome; they throw.) */
export type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; code: string; message: string };
/** Applies the domain effect of an outcome (state change + ledger) inside the transaction that settles the operation. */
export type ApplyFn = (client: PoolClient, op: OpRow, outcome: Outcome) => Promise<void>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The transactional outbox for provider calls.
 *
 * Intent is recorded in the caller's (short) DB transaction via `enqueue`. `execute` then performs the provider
 * call OUTSIDE any transaction and settles the result atomically with its domain effect. Every call carries the
 * operation's deterministic idempotency key, so re-running an operation (client retry, recovery worker, or a
 * re-claim after a crash) cannot produce a second effect at the provider.
 *
 * Single-flight: one executor claims an operation (`in_flight`, with a lease); others wait for it to settle.
 * A claim older than the lease is treated as abandoned and can be taken over.
 */
@Injectable()
export class ProviderOpsService {
  private readonly logger = new Logger(ProviderOpsService.name);

  constructor(
    private readonly db: DbService,
    private readonly providers: ProviderRegistry,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async enqueue(
    client: PoolClient,
    op: { paymentId: string; refundId?: string; kind: OpKind; provider: string; idempotencyKey: string; request: Record<string, unknown> },
  ): Promise<OpRow> {
    const r = await client.query<OpRow>(
      `INSERT INTO provider_operations (payment_id, refund_id, kind, provider, idempotency_key, request)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [op.paymentId, op.refundId ?? null, op.kind, op.provider, op.idempotencyKey, JSON.stringify(op.request)],
    );
    return r.rows[0];
  }

  async get(id: string): Promise<OpRow> {
    const r = await this.db.query<OpRow>('SELECT * FROM provider_operations WHERE id = $1', [id]);
    return r.rows[0];
  }

  /** The most recent operation of this kind for the payment that has not settled yet, if any. */
  async findOpen(paymentId: string, kind: OpKind): Promise<OpRow | undefined> {
    const r = await this.db.query<OpRow>(
      `SELECT * FROM provider_operations WHERE payment_id = $1 AND kind = $2 AND status IN ('pending','in_flight')
        ORDER BY created_at DESC LIMIT 1`,
      [paymentId, kind],
    );
    return r.rows[0];
  }

  async findForRefund(refundId: string): Promise<OpRow | undefined> {
    const r = await this.db.query<OpRow>('SELECT * FROM provider_operations WHERE refund_id = $1 ORDER BY created_at DESC LIMIT 1', [refundId]);
    return r.rows[0];
  }

  /** Number of earlier operations of this kind for the payment (used to derive per-attempt idempotency keys). */
  async countOps(client: PoolClient, paymentId: string, kind: OpKind): Promise<number> {
    const r = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM provider_operations WHERE payment_id = $1 AND kind = $2', [paymentId, kind]);
    return r.rows[0].n;
  }

  /**
   * Drive an operation to a terminal state and return it. Throws (leaving the operation retryable) when the
   * provider's outcome is unknown, e.g. a timeout; throws ServiceUnavailable if another executor holds it too long.
   */
  async execute(opId: string, apply: ApplyFn): Promise<OpRow> {
    const waitUntil = Date.now() + this.config.providerOpLeaseMs + this.config.providerTimeoutMs + 5_000;
    for (;;) {
      const current = await this.get(opId);
      if (current.status === 'succeeded' || current.status === 'failed') return current;

      const claimed = await this.claim(opId);
      if (!claimed) {
        if (Date.now() > waitUntil) {
          throw new ServiceUnavailableException({ code: 'operation_busy', message: `Provider operation ${opId} is still being processed elsewhere; retry shortly` });
        }
        await sleep(25);
        continue;
      }

      let outcome: Outcome;
      const labels = { provider: claimed.provider, operation: claimed.kind };
      const stopTimer = this.metrics.providerDuration.startTimer(labels);
      try {
        const attributes = { 'app.provider': claimed.provider, 'app.operation': claimed.kind, 'app.payment_id': claimed.payment_id, 'app.attempt': claimed.attempts };
        outcome = { ok: true, result: await withSpan(`provider_operation ${claimed.kind}`, { attributes }, () => this.callProvider(claimed)) };
        this.metrics.providerCalls.inc({ ...labels, outcome: 'success' });
      } catch (err) {
        if (!(err instanceof ProviderRejectedError)) {
          this.metrics.providerCalls.inc({ ...labels, outcome: 'error' });
          await this.release(opId, err); // outcome unknown: leave it retryable (same idempotency key next time)
          throw err;
        }
        this.metrics.providerCalls.inc({ ...labels, outcome: 'rejected' });
        outcome = { ok: false, code: err.code, message: err.message };
      } finally {
        stopTimer();
      }

      try {
        return await this.settle(opId, outcome, apply);
      } catch (err) {
        // The provider call is idempotent, so letting the next executor redo it and apply again is safe.
        await this.release(opId, err);
        throw err;
      }
    }
  }

  private async claim(opId: string): Promise<OpRow | undefined> {
    const r = await this.db.query<OpRow>(
      `UPDATE provider_operations
          SET status = 'in_flight', claimed_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1
          AND (status = 'pending' OR (status = 'in_flight' AND claimed_at < now() - ($2::int * interval '1 millisecond')))
        RETURNING *`,
      [opId, this.config.providerOpLeaseMs],
    );
    return r.rows[0];
  }

  private async release(opId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`Provider operation ${opId} not completed (${message}); it stays retryable`);
    await this.db
      .query(`UPDATE provider_operations SET status = 'pending', claimed_at = NULL, error_message = $2, updated_at = now() WHERE id = $1 AND status = 'in_flight'`, [opId, message.slice(0, 500)])
      .catch(() => undefined);
  }

  private async settle(opId: string, outcome: Outcome, apply: ApplyFn): Promise<OpRow> {
    return this.db.tx(async (client) => {
      const locked = await client.query<OpRow>('SELECT * FROM provider_operations WHERE id = $1 FOR UPDATE', [opId]);
      const op = locked.rows[0];
      if (op.status === 'succeeded' || op.status === 'failed') return op; // settled by an overlapping executor
      await apply(client, op, outcome);
      const done = await client.query<OpRow>(
        `UPDATE provider_operations
            SET status = $2, result = $3, error_code = $4, error_message = $5, claimed_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          opId,
          outcome.ok ? 'succeeded' : 'failed',
          outcome.ok ? JSON.stringify(outcome.result) : null,
          outcome.ok ? null : outcome.code,
          outcome.ok ? null : outcome.message,
        ],
      );
      return done.rows[0];
    });
  }

  private async callProvider(op: OpRow): Promise<Record<string, unknown>> {
    const provider = this.providers.get(op.provider);
    const r = op.request;
    switch (op.kind) {
      case 'authorize':
        return provider.authorize({
          paymentId: op.payment_id,
          amount: r.amount,
          currency: r.currency,
          idempotencyKey: op.idempotency_key,
          paymentMethod: r.paymentMethod,
        });
      case 'capture':
        return provider.capture({
          paymentId: op.payment_id,
          providerRef: r.providerRef,
          amount: r.amount,
          currency: r.currency,
          idempotencyKey: op.idempotency_key,
        });
      case 'refund':
        return provider.refund({
          refundId: op.refund_id as string,
          providerRef: r.providerRef,
          amount: r.amount,
          currency: r.currency,
          idempotencyKey: op.idempotency_key,
        });
      case 'void':
        await provider.void({ paymentId: op.payment_id, providerRef: r.providerRef, idempotencyKey: op.idempotency_key });
        return {};
    }
  }
}
