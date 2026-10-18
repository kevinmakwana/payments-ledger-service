import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';

export interface PurgeResult {
  idempotencyKeys: number;
  webhookEvents: number;
}

/**
 * Retention for tables that otherwise grow forever. Deletes run in small batches so no single statement
 * holds locks or bloats WAL for long. Only data that can no longer matter is removed:
 *  - idempotency keys past the TTL (a client reusing a key later than that would create a duplicate),
 *  - webhook events that were PROCESSED long ago. `received` (still in flight) and `dead` (awaiting a human) are kept.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async purge(batchSize = 5000): Promise<PurgeResult> {
    const keyCutoff = new Date(Date.now() - this.config.idempotencyKeyTtlHours * 3_600_000);
    const eventCutoff = new Date(Date.now() - this.config.webhookRetentionDays * 86_400_000);

    const idempotencyKeys = await this.deleteInBatches(
      `DELETE FROM idempotency_keys WHERE (scope, key) IN
         (SELECT scope, key FROM idempotency_keys WHERE created_at < $1 ORDER BY created_at LIMIT $2)`,
      keyCutoff,
      batchSize,
    );
    const webhookEvents = await this.deleteInBatches(
      `DELETE FROM webhook_events WHERE (provider, event_id) IN
         (SELECT provider, event_id FROM webhook_events WHERE status = 'processed' AND processed_at < $1 ORDER BY processed_at LIMIT $2)`,
      eventCutoff,
      batchSize,
    );
    if (idempotencyKeys + webhookEvents > 0) {
      this.logger.log(`Retention purged ${idempotencyKeys} idempotency key(s) and ${webhookEvents} processed webhook event(s)`);
    }
    return { idempotencyKeys, webhookEvents };
  }

  private async deleteInBatches(sql: string, cutoff: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.db.query(sql, [cutoff, batchSize]);
      total += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < batchSize) return total;
    }
  }
}
