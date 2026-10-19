import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AlertService } from '../alerts/alert.service';
import { RECONCILIATION_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ReconciliationService } from './reconciliation.service';

/** Nightly job: reconcile yesterday (UTC) for the default provider and keep the report. */
@Processor(RECONCILIATION_QUEUE, { autorun: false })
export class ReconciliationProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(
    private readonly reconciliation: ReconciliationService,
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
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const report = await this.reconciliation.reconcile((job.data?.date as string | undefined) ?? yesterday);
    if (report.summary.mismatches > 0) {
      this.logger.error(`Reconciliation ${report.date}: ${report.summary.mismatches} mismatch(es)`);
      await this.alerts.raise({
        kind: 'reconciliation_mismatch',
        severity: 'critical',
        message: `Reconciliation for ${report.date} found ${report.summary.mismatches} mismatch(es) between ${report.provider} and the ledger`,
        details: { provider: report.provider, date: report.date, ...report.summary, sample: report.mismatches.slice(0, 5) },
      });
    } else {
      this.logger.log(`Reconciliation ${report.date}: ${report.summary.matched} transactions matched`);
    }
    return report.summary;
  }
}
