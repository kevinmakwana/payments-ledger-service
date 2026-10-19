import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PAYMENT_RECOVERY_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PaymentsRecoveryService } from './payments-recovery.service';

/** Runs the recovery sweep on a shared Redis-backed schedule (one run per tick however many instances run). */
@Processor(PAYMENT_RECOVERY_QUEUE, { autorun: false })
export class PaymentsRecoveryProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly recovery: PaymentsRecoveryService,
    @InjectQueue(PAYMENT_RECOVERY_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.schedulersEnabled) return;
    await this.queue.upsertJobScheduler('payment-recovery', { pattern: this.config.paymentRecoveryCron, tz: 'UTC' }, { name: 'sweep' });
  }

  async process(_job: Job): Promise<unknown> {
    return this.recovery.sweep();
  }
}
