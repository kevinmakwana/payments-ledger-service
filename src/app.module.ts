import { BullModule } from '@nestjs/bullmq';
import { Controller, Get, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { APP_CONFIG, AppConfig, redisConnection } from './config/config';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { LedgerModule } from './ledger/ledger.module';
import { PaymentsModule } from './payments/payments.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@ApiExcludeController()
@Controller('health')
class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ConfigModule,
    DbModule,
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: redisConnection(config.redisUrl),
        prefix: config.queuePrefix,
      }),
    }),
    LedgerModule,
    PaymentsModule,
    WebhooksModule,
    PayoutsModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
