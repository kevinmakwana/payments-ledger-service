import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import type { ProviderTransaction } from '../providers/provider.interface';
import { AlertService } from '../alerts/alert.service';
import { RECONCILIATION_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ProviderRegistry } from '../providers/provider.registry';
import { ReconciliationItemsService } from './reconciliation-items.service';
import { ReconciliationService } from './reconciliation.service';

/** The `days` UTC days ending yesterday, oldest first. */
export const lookbackDates = (days: number, now = Date.now()): string[] =>
  Array.from({ length: days }, (_, i) => new Date(now - (days - i) * 86_400_000).toISOString().slice(0, 10));

/**
 * Nightly job. For every available provider it reconciles the last RECONCILIATION_LOOKBACK_DAYS days (not just
 * yesterday, so a webhook that arrives late closes the discrepancy it caused by itself), alerts about discrepancies
 * seen for the first time, and alerts every night about items that have stayed open too long.
 * A job with `data.date` reconciles just that day.
 */
@Processor(RECONCILIATION_QUEUE, { autorun: false })
export class ReconciliationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly items: ReconciliationItemsService,
    private readonly providers: ProviderRegistry,
    private readonly alerts: AlertService,
    @InjectQueue(RECONCILIATION_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.schedulersEnabled) return;
    await this.queue.upsertJobScheduler('nightly-reconciliation', { pattern: '0 3 * * *', tz: 'UTC' }, { name: 'nightly' });
  }

  async process(job: Job): Promise<unknown> {
    const given = job.data?.date as string | undefined;
    const dates = given ? [given] : lookbackDates(this.config.reconciliationLookbackDays);
    const totals = { days: 0, matched: 0, mismatches: 0, new: 0, autoResolved: 0 };
    const failures: unknown[] = [];

    for (const provider of this.providers.available()) {
      const listings = new Map<string, Promise<ProviderTransaction[]>>();
      for (const date of dates) {
        try {
          const report = await this.reconciliation.reconcile(date, provider, listings);
          totals.days++;
          totals.matched += report.summary.matched;
          totals.mismatches += report.summary.open;
          totals.new += report.summary.new;
          totals.autoResolved += report.summary.autoResolved;
          if (report.summary.new > 0) {
            this.logger.error(`Reconciliation ${provider} ${date}: ${report.summary.new} new mismatch(es)`);
            await this.alerts.raise({
              kind: 'reconciliation_mismatch',
              severity: 'critical',
              message: `Reconciliation for ${date} found ${report.summary.new} new mismatch(es) between ${provider} and the ledger`,
              details: { provider, date, ...report.summary, sample: report.mismatches.filter((m) => m.isNew).slice(0, 5) },
            });
          } else {
            this.logger.log(`Reconciliation ${provider} ${date}: ${report.summary.matched} matched, ${report.summary.open} open, ${report.summary.autoResolved} auto-resolved`);
          }
        } catch (err) {
          // One provider being unreachable must not stop the others from being reconciled; the job still fails at the end.
          this.logger.error(`Reconciliation ${provider} ${date} failed: ${err instanceof Error ? err.message : String(err)}`);
          failures.push(err);
          break; // later days of this provider would fail the same way
        }
      }
    }

    const stale = await this.items.stale(this.config.reconciliationStaleDays);
    if (stale.count > 0) {
      await this.alerts.raise({
        kind: 'reconciliation_item_stale',
        severity: 'critical',
        message: `${stale.count} reconciliation item(s) have been open for ${this.config.reconciliationStaleDays}+ days; resolve them or ignore them with a note`,
        details: { count: stale.count, staleAfterDays: this.config.reconciliationStaleDays, oldest: stale.oldest.slice(0, 5) },
      });
    }

    if (failures.length > 0) throw failures[0];
    return totals;
  }
}
