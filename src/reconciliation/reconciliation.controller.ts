import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Principal } from '../auth/api-keys';
import { AdminOnly, CurrentPrincipal } from '../auth/auth.decorators';
import { PageQuery } from '../common/pagination';
import { ReconciliationItemsService } from './reconciliation-items.service';
import { ReconciliationService } from './reconciliation.service';

class ListItemsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['open', 'resolved', 'ignored'] }) @IsOptional() @IsIn(['open', 'resolved', 'ignored'])
  status?: string;

  @ApiPropertyOptional({ enum: ['simulated', 'stripe', 'razorpay'] }) @IsOptional() @IsIn(['simulated', 'stripe', 'razorpay'])
  provider?: string;

  @ApiPropertyOptional({ enum: ['missing_in_ledger', 'missing_at_provider', 'amount_mismatch'] })
  @IsOptional() @IsIn(['missing_in_ledger', 'missing_at_provider', 'amount_mismatch'])
  type?: string;

  @ApiPropertyOptional({ example: '2026-03-10', description: 'UTC day the discrepancy belongs to' })
  @IsOptional() @IsDateString({ strict: true }) @Length(10, 10)
  date?: string;
}

class IgnoreItemDto {
  @ApiProperty({ example: 'Test charge made from the Stripe dashboard', description: 'Why this discrepancy is acceptable. Required, so there is always a record.' })
  @IsString() @Length(3, 500)
  note!: string;
}

const actor = (p: Principal | undefined) => p?.keyId ?? 'anonymous';

@ApiTags('reports')
@AdminOnly()
@Controller('reports')
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly items: ReconciliationItemsService,
  ) {}

  @Get('reconciliation')
  @ApiQuery({ name: 'date', example: '2026-03-10', description: 'UTC day, YYYY-MM-DD' })
  @ApiQuery({ name: 'provider', required: false, example: 'simulated' })
  @ApiOperation({ summary: 'Reconcile a day now: compare provider-reported transactions with ledger entries, track the discrepancies and close the ones that now match' })
  report(@Query('date') date?: string, @Query('provider') provider?: string) {
    if (!date) throw new BadRequestException('date is required (YYYY-MM-DD)');
    return this.reconciliation.reconcile(date, provider);
  }

  @Get('reconciliation/items')
  @ApiOperation({ summary: 'List tracked discrepancies, newest first (filters + cursor pagination)' })
  list(@Query() query: ListItemsQuery) {
    return this.items.list(query);
  }

  @Get('reconciliation/items/:id')
  @ApiOperation({ summary: 'Fetch one discrepancy' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.items.get(id);
  }

  @Post('reconciliation/items/:id/ignore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept a discrepancy as known and expected (a note is required). It stays ignored while it is unchanged.' })
  ignore(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IgnoreItemDto, @CurrentPrincipal() by?: Principal) {
    return this.items.ignore(id, dto.note, actor(by));
  }

  @Post('reconciliation/items/:id/reopen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Put an ignored discrepancy back in the open queue' })
  reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() by?: Principal) {
    return this.items.reopen(id, actor(by));
  }
}
