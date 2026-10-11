import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WEBHOOK_DLQ, WEBHOOK_QUEUE } from '../common/queues';
import { PayoutsModule } from '../payouts/payouts.module';
import { ProvidersModule } from '../providers/providers.module';
import { WebhookHandlers } from './webhook-handlers';
import { WebhooksController } from './webhooks.controller';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [
    ProvidersModule,
    PayoutsModule,
    BullModule.registerQueue({ name: WEBHOOK_QUEUE }, { name: WEBHOOK_DLQ }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookHandlers, WebhooksProcessor],
})
export class WebhooksModule {}
