import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RECONCILIATION_QUEUE } from '../common/queues';
import { ProvidersModule } from '../providers/providers.module';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationProcessor } from './reconciliation.processor';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [ProvidersModule, BullModule.registerQueue({ name: RECONCILIATION_QUEUE })],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationProcessor],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
