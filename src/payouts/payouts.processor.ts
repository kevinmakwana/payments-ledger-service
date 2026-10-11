import { OnModuleInit, Inject, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PAYOUT_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PayoutsService } from './payouts.service';

/** Consumes the payouts queue: the daily batch trigger and per-payout dispatch jobs. */
@Processor(PAYOUT_QUEUE)
export class PayoutsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PayoutsProcessor.name);

  constructor(
    private readonly payouts: PayoutsService,
    @InjectQueue(PAYOUT_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.schedulersEnabled) return;
    // A job scheduler is stored in Redis, so multiple app instances register one shared schedule.
    await this.queue.upsertJobScheduler('daily-payouts', { pattern: '0 2 * * *', tz: 'UTC' }, { name: 'run-batch' });
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'run-batch': {
        const lines = await this.payouts.runBatch();
        this.logger.log(`Payout batch created ${lines.filter((l) => l.payoutId).length} payouts`);
        return { payouts: lines.filter((l) => l.payoutId).length };
      }
      case 'dispatch':
        await this.payouts.dispatch(job.data.payoutId as string);
        return undefined;
      default:
        throw new Error(`Unknown payout job ${job.name}`);
    }
  }
}
