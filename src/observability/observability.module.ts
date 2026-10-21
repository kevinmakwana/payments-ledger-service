import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import {
  MAINTENANCE_QUEUE,
  MONITOR_QUEUE,
  PAYMENT_RECOVERY_QUEUE,
  PAYOUT_QUEUE,
  RECONCILIATION_QUEUE,
  WEBHOOK_DLQ,
  WEBHOOK_QUEUE,
} from '../common/queues';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { TracingLifecycle } from './tracing.lifecycle';

@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: WEBHOOK_QUEUE },
      { name: WEBHOOK_DLQ },
      { name: PAYOUT_QUEUE },
      { name: RECONCILIATION_QUEUE },
      { name: MONITOR_QUEUE },
      { name: MAINTENANCE_QUEUE },
      { name: PAYMENT_RECOVERY_QUEUE },
    ),
  ],
  controllers: [MetricsController],
  providers: [MetricsService, TracingLifecycle, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
  exports: [MetricsService],
})
export class ObservabilityModule {}
