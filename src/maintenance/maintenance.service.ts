import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';

export interface PurgeResult {
  idempotencyKeys: number;
  webhookEvents: number;
  reconciliationItems: number;
}

/**
 * Retention for tables that otherwise grow forever. Deletes run in small batches so no single statement
 * holds locks or bloats WAL for long. Only data that can no longer matter is removed:
 *  - idempotency keys past the TTL (a client reusing a key later than that would create a duplicate),
 *  - webhook events that were PROCESSED long ago. `received` (still in flight) and `dead` (awaiting a human) are kept,
 *  - reconciliation items that were resolved or ignored long ago. `open` items are kept however old: someone still owes them an answer.
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
    const itemCutoff = new Date(Date.now() - this.config.reconciliationItemRetentionDays * 86_400_000);

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
    const reconciliationItems = await this.deleteInBatches(
      `DELETE FROM reconciliation_items WHERE id IN
         (SELECT id FROM reconciliation_items WHERE status IN ('resolved', 'ignored') AND resolved_at < $1 ORDER BY resolved_at LIMIT $2)`,
      itemCutoff,
      batchSize,
    );
    if (idempotencyKeys + webhookEvents + reconciliationItems > 0) {
      this.logger.log(
        `Retention purged ${idempotencyKeys} idempotency key(s), ${webhookEvents} processed webhook event(s) and ${reconciliationItems} closed reconciliation item(s)`,
      );
    }
    return { idempotencyKeys, webhookEvents, reconciliationItems };
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
