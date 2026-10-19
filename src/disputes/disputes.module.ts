import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';

@Module({ imports: [LedgerModule], controllers: [DisputesController], providers: [DisputesService], exports: [DisputesService] })
export class DisputesModule {}
