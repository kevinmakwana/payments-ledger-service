import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_AMOUNT_MINOR } from '../common/money';
import { PageQuery } from '../common/pagination';
import { PAYMENT_STATUSES } from './state-machine';

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export class CreatePaymentDto {
  @ApiProperty({ example: 'buyer_42' })
  @IsString() @Matches(ID)
  buyerId!: string;

  @ApiProperty({ example: 'acme_bikes', description: 'Seller on Acme Market receiving the funds' })
  @IsString() @Matches(ID)
  sellerId!: string;

  @ApiProperty({ example: 10000, description: 'Integer minor units (cents)' })
  @IsInt() @Min(1) @Max(MAX_AMOUNT_MINOR)
  amount!: number;

  @ApiProperty({ example: 'USD' })
  @IsString() @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ApiPropertyOptional({ enum: ['simulated', 'stripe', 'razorpay'], default: 'simulated' })
  @IsOptional() @IsIn(['simulated', 'stripe', 'razorpay'])
  provider?: string;

  @ApiPropertyOptional({ description: 'Provider payment-method token (ignored by the simulator)' })
  @IsOptional() @IsString() @MaxLength(255)
  paymentMethod?: string;

  @ApiPropertyOptional({ default: false, description: 'Capture immediately after authorizing' })
  @IsOptional() @IsBoolean()
  capture?: boolean;
}

export class RefundDto {
  @ApiPropertyOptional({ example: 2500, description: 'Minor units; omit to refund the remaining balance' })
  @IsOptional() @IsInt() @Min(1) @Max(MAX_AMOUNT_MINOR)
  amount?: number;
}

export class ListPaymentsQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID)
  sellerId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(ID)
  buyerId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES }) @IsOptional() @IsIn([...PAYMENT_STATUSES])
  status?: string;

  @ApiPropertyOptional({ enum: ['simulated', 'stripe', 'razorpay'] }) @IsOptional() @IsIn(['simulated', 'stripe', 'razorpay'])
  provider?: string;

  @ApiPropertyOptional({ description: 'Created at or after this instant (ISO-8601)' }) @IsOptional() @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'Created before this instant (ISO-8601)' }) @IsOptional() @IsDateString()
  createdTo?: string;
}

