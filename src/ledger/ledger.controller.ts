import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LedgerService } from './ledger.service';

@ApiTags('ledger')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('trial-balance')
  @ApiOperation({ summary: 'All account balances plus proof that postings sum to zero per currency' })
  trialBalance() {
    return this.ledger.trialBalance();
  }

  @Get('accounts/:code')
  @ApiOperation({ summary: 'Balance of one account (cached and derived from postings)' })
  async account(@Param('code') code: string) {
    const account = await this.ledger.accountView(code);
    if (!account) throw new NotFoundException(`No account ${code}`);
    return account;
  }
}
