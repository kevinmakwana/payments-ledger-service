import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { MAINTENANCE_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { MaintenanceService } from './maintenance.service';

/** Runs the retention purge on a shared Redis-backed schedule (once per tick however many instances run). */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly maintenance: MaintenanceService,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.schedulersEnabled) return;
    await this.queue.upsertJobScheduler('retention-purge', { pattern: this.config.maintenanceCron, tz: 'UTC' }, { name: 'purge' });
  }

  async process(_job: Job): Promise<unknown> {
    return this.maintenance.purge();
  }
}
