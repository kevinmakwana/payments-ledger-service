import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { MarginController } from './margin.controller';
import { LedgerService } from './ledger.service';
import { ProviderFeesService } from './provider-fees.service';

@Module({
  controllers: [LedgerController, MarginController],
  providers: [LedgerService, ProviderFeesService],
  exports: [LedgerService, ProviderFeesService],
})
export class LedgerModule {}
