import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PAYOUT_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { LedgerModule } from '../ledger/ledger.module';
import { ProvidersModule } from '../providers/providers.module';
import { PayoutsController } from './payouts.controller';
import { PayoutsProcessor } from './payouts.processor';
import { PayoutsService } from './payouts.service';

@Module({
  imports: [
    LedgerModule,
    ProvidersModule,
    BullModule.registerQueueAsync({
      name: PAYOUT_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: config.webhookBackoffMs },
          removeOnComplete: 1000,
        },
      }),
    }),
  ],
  controllers: [PayoutsController],
  providers: [PayoutsService, PayoutsProcessor],
  exports: [PayoutsService],
})
export class PayoutsModule {}
