import { Inject, Injectable, Logger } from '@nestjs/common';
import { AlertService } from '../alerts/alert.service';
import { IllegalTransitionError } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { PaymentsService } from './payments.service';

export interface RecoveryResult {
  advanced: string[];
  refunds: string[];
  expired: string[];
  stuckOperations: number;
}

const BATCH = 100;

/**
 * The safety net behind the outbox. Anything a crashed or timed-out request left half-done is driven forward here,
 * which is safe because every provider call carries a deterministic idempotency key and every step is state-driven.
 * Also expires authorizations nobody captured, and alerts on operations that keep failing to complete.
 */
@Injectable()
export class PaymentsRecoveryService {
  private readonly logger = new Logger(PaymentsRecoveryService.name);

  constructor(
    private readonly db: DbService,
    private readonly payments: PaymentsService,
    private readonly alerts: AlertService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sweep(): Promise<RecoveryResult> {
    const idleBefore = new Date(Date.now() - this.config.paymentRecoveryAgeMs);
    const result: RecoveryResult = { advanced: [], refunds: [], expired: [], stuckOperations: 0 };

    // Payments with a provider call pending (or a capture-on-create waiting to start), idle long enough to be orphaned.
    const stuck = await this.db.query<{ id: string }>(
      `SELECT id FROM payments
        WHERE updated_at < $1 AND (status IN ('created','capturing','voiding') OR (status = 'authorized' AND capture_requested))
        ORDER BY updated_at LIMIT ${BATCH}`,
      [idleBefore],
    );
    for (const { id } of stuck.rows) {
      if (await this.attempt(`advance payment ${id}`, () => this.payments.advance(id))) result.advanced.push(id);
    }

    const refunds = await this.db.query<{ id: string }>(
      `SELECT id FROM refunds WHERE status = 'pending' AND updated_at < $1 ORDER BY updated_at LIMIT ${BATCH}`,
      [idleBefore],
    );
    for (const { id } of refunds.rows) {
      if (await this.attempt(`complete refund ${id}`, () => this.payments.finishRefund(id))) result.refunds.push(id);
    }

    // Authorizations nobody captured within the TTL are voided at the provider and marked `expired`.
    const expiredBefore = new Date(Date.now() - this.config.authorizationTtlHours * 3_600_000);
    const stale = await this.db.query<{ id: string }>(
      `SELECT id FROM payments WHERE status = 'authorized' AND NOT capture_requested AND authorized_at < $1 ORDER BY authorized_at LIMIT ${BATCH}`,
      [expiredBefore],
    );
    for (const { id } of stale.rows) {
      const ok = await this.attempt(`expire payment ${id}`, async () => {
        try {
          await this.payments.expire(id);
        } catch (err) {
          if (!(err instanceof IllegalTransitionError)) throw err; // captured/voided concurrently: nothing to do
        }
      });
      if (ok) result.expired.push(id);
    }

    const open = await this.db.query<{ n: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, min(created_at) AS oldest FROM provider_operations
        WHERE status IN ('pending','in_flight') AND attempts >= $1`,
      [this.config.providerOpMaxAttempts],
    );
    result.stuckOperations = open.rows[0].n;
    if (result.stuckOperations > 0) {
      await this.alerts.raise({
        kind: 'provider_operation_stuck',
        severity: 'critical',
        message: `${result.stuckOperations} provider operation(s) have failed to complete after ${this.config.providerOpMaxAttempts}+ attempts; check the provider and the payments involved`,
        details: { count: result.stuckOperations, oldest: open.rows[0].oldest },
      });
    }
    return result;
  }

  /** One bad payment must never stop the sweep for the others. */
  private async attempt(what: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.logger.warn(`Recovery could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
