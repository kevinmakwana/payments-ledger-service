import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PAYMENT_RECOVERY_QUEUE } from '../common/queues';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ProvidersModule } from '../providers/providers.module';
import { PaymentsController } from './payments.controller';
import { PaymentsRecoveryProcessor } from './payments-recovery.processor';
import { PaymentsRecoveryService } from './payments-recovery.service';
import { PaymentsService } from './payments.service';
import { ProviderOpsService } from './provider-ops.service';

@Module({
  imports: [LedgerModule, ProvidersModule, IdempotencyModule, BullModule.registerQueue({ name: PAYMENT_RECOVERY_QUEUE })],
  controllers: [PaymentsController],
  providers: [PaymentsService, ProviderOpsService, PaymentsRecoveryService, PaymentsRecoveryProcessor],
  exports: [PaymentsService, ProviderOpsService],
})
export class PaymentsModule {}
