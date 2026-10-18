import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminOnly } from '../auth/auth.decorators';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('reports')
@AdminOnly()
@Controller('reports')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('reconciliation')
  @ApiQuery({ name: 'date', example: '2026-03-10', description: 'UTC day, YYYY-MM-DD' })
  @ApiQuery({ name: 'provider', required: false, example: 'simulated' })
  @ApiOperation({ summary: 'Compare provider-reported transactions with ledger entries for a day' })
  report(@Query('date') date?: string, @Query('provider') provider?: string) {
    if (!date) throw new BadRequestException('date is required (YYYY-MM-DD)');
    return this.reconciliation.reconcile(date, provider);
  }
}
