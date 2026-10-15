import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MONITOR_QUEUE } from '../common/queues';
import { LedgerModule } from '../ledger/ledger.module';
import { MonitorProcessor } from './monitor.processor';
import { MonitorService } from './monitor.service';

@Module({
  imports: [LedgerModule, BullModule.registerQueue({ name: MONITOR_QUEUE })],
  providers: [MonitorService, MonitorProcessor],
  exports: [MonitorService],
})
export class MonitoringModule {}
