import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { PayoutsService } from './payouts.service';

class RunPayoutsDto {
  @ApiPropertyOptional({ description: 'Evaluate holds as of this instant (default: now). Useful for demos/backfills.' })
  @IsOptional() @IsDateString()
  asOf?: string;
}

@ApiTags('payouts')
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post('payouts/run')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the payout batch now (the same job the daily scheduler runs)' })
  run(@Body() dto: RunPayoutsDto) {
    return this.payouts.runBatch(dto.asOf ? new Date(dto.asOf) : new Date());
  }

  @Get('payouts')
  @ApiOperation({ summary: 'List payouts, optionally for one seller' })
  list(@Query('sellerId') sellerId?: string) {
    return this.payouts.list(sellerId);
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Fetch a payout' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payouts.get(id);
  }

  @Get('sellers/:sellerId/balance')
  @ApiOperation({ summary: 'Seller ledger balance and the part available for payout (after hold + reserve)' })
  balance(@Param('sellerId') sellerId: string, @Query('currency') currency = 'USD') {
    if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('currency must be a 3-letter code');
    return this.payouts.sellerBalance(sellerId, currency);
  }
}
