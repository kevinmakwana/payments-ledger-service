import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { PageQuery } from '../common/pagination';
import { AdminOnly } from '../auth/auth.decorators';
import { PayoutsService } from './payouts.service';

class RunPayoutsDto {
  @ApiPropertyOptional({ description: 'Evaluate holds as of this instant (default: now). Useful for demos/backfills.' })
  @IsOptional() @IsDateString()
  asOf?: string;
}

class ListPayoutsQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_.:-]{1,64}$/)
  sellerId?: string;

  @ApiPropertyOptional({ enum: ['pending', 'paid', 'failed'] }) @IsOptional() @IsIn(['pending', 'paid', 'failed'])
  status?: string;

  @ApiPropertyOptional({ enum: ['simulated', 'stripe', 'razorpay'] }) @IsOptional() @IsIn(['simulated', 'stripe', 'razorpay'])
  provider?: string;
}

@ApiTags('payouts')
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post('payouts/run')
  @AdminOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Run the payout batch now (the same job the daily scheduler runs)' })
  run(@Body() dto: RunPayoutsDto) {
    return this.payouts.runBatch(dto.asOf ? new Date(dto.asOf) : new Date());
  }

  @Get('payouts')
  @AdminOnly()
  @ApiOperation({ summary: 'List payouts, newest first (filters + cursor pagination)' })
  list(@Query() query: ListPayoutsQuery) {
    return this.payouts.list(query);
  }

  @Get('payouts/:id')
  @AdminOnly()
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
