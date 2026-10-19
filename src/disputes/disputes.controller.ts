import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { AdminOnly } from '../auth/auth.decorators';
import { PageQuery } from '../common/pagination';
import { DisputesService } from './disputes.service';

export class ListDisputesQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['open', 'won', 'lost'] }) @IsOptional() @IsIn(['open', 'won', 'lost'])
  status?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  paymentId?: string;

  @ApiPropertyOptional({ enum: ['simulated', 'stripe', 'razorpay'] }) @IsOptional() @IsIn(['simulated', 'stripe', 'razorpay'])
  provider?: string;
}

@ApiTags('disputes')
@AdminOnly()
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @ApiOperation({ summary: 'List disputes (chargebacks), newest first' })
  list(@Query() query: ListDisputesQuery) {
    return this.disputes.list(query);
  }
}
