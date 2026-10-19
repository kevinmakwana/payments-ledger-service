import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { MONITOR_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { MonitorService } from './monitor.service';

/** Runs the monitor checks on a shared Redis-backed schedule (one run per tick, however many instances). */
@Processor(MONITOR_QUEUE, { autorun: false })
export class MonitorProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly monitor: MonitorService,
    @InjectQueue(MONITOR_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.schedulersEnabled) return;
    await this.queue.upsertJobScheduler('monitor-checks', { pattern: this.config.monitorCron, tz: 'UTC' }, { name: 'check' });
  }

  async process(_job: Job): Promise<unknown> {
    const raised = await this.monitor.run();
    return { alerts: raised.map((a) => a.kind) };
  }
}
