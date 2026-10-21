import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RECONCILIATION_QUEUE } from '../common/queues';
import { LedgerModule } from '../ledger/ledger.module';
import { ProvidersModule } from '../providers/providers.module';
import { ReconciliationItemsService } from './reconciliation-items.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationProcessor } from './reconciliation.processor';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [ProvidersModule, LedgerModule, BullModule.registerQueue({ name: RECONCILIATION_QUEUE })],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationItemsService, ReconciliationProcessor],
  exports: [ReconciliationService, ReconciliationItemsService],
})
export class ReconciliationModule {}
