import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AlertsModule } from './alerts/alerts.module';
import { APP_CONFIG, AppConfig, redisConnection } from './config/config';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { PaymentsModule } from './payments/payments.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    AlertsModule,
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
    HealthModule,
    MonitoringModule,
  ],
})
export class AppModule {}
