import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '../common/pagination';
import { AdminOnly } from '../auth/auth.decorators';
import { LedgerService } from './ledger.service';

class ListEntriesQuery extends PageQuery {
  @ApiPropertyOptional({ example: 'capture' }) @IsOptional() @IsString() @MaxLength(64)
  kind?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  paymentId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  payoutId?: string;

  @ApiPropertyOptional({ example: 'seller:acme_bikes:USD', description: 'Only entries with a posting on this account' }) @IsOptional() @IsString() @MaxLength(128)
  accountCode?: string;

  @ApiPropertyOptional({ description: 'Created at or after (ISO-8601)' }) @IsOptional() @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Created before (ISO-8601)' }) @IsOptional() @IsDateString()
  to?: string;
}

@ApiTags('ledger')
@AdminOnly()
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('trial-balance')
  @ApiOperation({ summary: 'All account balances plus proof that postings sum to zero per currency' })
  trialBalance() {
    return this.ledger.trialBalance();
  }

  @Get('entries')
  @ApiOperation({ summary: 'Journal entries with their postings, newest first (filters + cursor pagination)' })
  entries(@Query() query: ListEntriesQuery) {
    return this.ledger.entries(query);
  }

  @Get('accounts/:code/statement')
  @ApiOperation({ summary: 'An account\'s postings, newest first, with the running balance after each' })
  statement(@Param('code') code: string, @Query() query: PageQuery) {
    return this.ledger.statement(code, query);
  }

  @Get('accounts/:code')
  @ApiOperation({ summary: 'Balance of one account (cached and derived from postings)' })
  async account(@Param('code') code: string) {
    const account = await this.ledger.accountView(code);
    if (!account) throw new NotFoundException(`No account ${code}`);
    return account;
  }
}
