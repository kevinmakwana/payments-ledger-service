import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BullMQOtel } from 'bullmq-otel';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { APP_CONFIG, AppConfig, redisConnection } from './config/config';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { LedgerModule } from './ledger/ledger.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { ObservabilityModule } from './observability/observability.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { PaymentsModule } from './payments/payments.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WorkerModule } from './worker/worker.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    AlertsModule,
    ObservabilityModule,
    AuthModule,
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        connection: redisConnection(config.redisUrl),
        prefix: config.queuePrefix,
        // Producers store the active trace context on each job and workers continue it, so one trace spans
        // the API request and the background work it caused.
        telemetry: config.tracingEnabled ? new BullMQOtel({ tracerName: 'payments-ledger-service' }) : undefined,
      }),
    }),
    LedgerModule,
    PaymentsModule,
    WebhooksModule,
    PayoutsModule,
    ReconciliationModule,
    HealthModule,
    MonitoringModule,
    MaintenanceModule,
    WorkerModule,
  ],
})
export class AppModule {}
