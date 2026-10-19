import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CreatePaymentDto, ListPaymentsQuery, RefundDto } from './payments.dto';
import { PaymentsService } from './payments.service';

const IdempotencyKeyHeader = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: 'Unique per logical request. Replays return the stored response; reuse with a different body returns 409.',
});

const OptionalIdempotencyKeyHeader = ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description: 'Optional. A retry with the same key replays or resumes the first request instead of failing with 409.',
});

function requireKey(key: string | undefined): string {
  if (!key || key.length > 255) throw new BadRequestException('Idempotency-Key header is required (max 255 chars)');
  return key;
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @IdempotencyKeyHeader
  @ApiOperation({ summary: 'Create and authorize a payment (optionally capture)' })
  @ApiResponse({ status: 201, description: 'Authorized (or captured, with capture=true)' })
  @ApiResponse({ status: 402, description: 'Declined. The failed attempt is persisted (status `failed`) and replayed for the same key.' })
  @ApiResponse({ status: 504, description: 'The provider did not answer in time. Retry with the same Idempotency-Key.' })
  async create(
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.payments.create(dto, requireKey(key)));
  }

  @Get()
  @ApiOperation({ summary: 'List payments, newest first (filters + cursor pagination)' })
  list(@Query() query: ListPaymentsQuery) {
    return this.payments.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a payment' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id);
  }

  @Post(':id/capture')
  @HttpCode(200)
  @OptionalIdempotencyKeyHeader
  @ApiOperation({ summary: 'Capture an authorized payment and post the fee split to the ledger' })
  @ApiResponse({ status: 402, description: 'The capture was declined; the payment stays authorized.' })
  async capture(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.payments.capture(id, key === undefined ? undefined : requireKey(key)));
  }

  @Post(':id/void')
  @HttpCode(200)
  @OptionalIdempotencyKeyHeader
  @ApiOperation({ summary: 'Void (cancel) an authorized payment that will not be captured' })
  @ApiResponse({ status: 422, description: 'The provider refused to void (the payment stays authorized).' })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.payments.void(id, key === undefined ? undefined : requireKey(key)));
  }

  @Post(':id/refunds')
  @IdempotencyKeyHeader
  @ApiOperation({ summary: 'Refund (fully or partially) a captured payment' })
  async refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.payments.refund(id, dto.amount, requireKey(key)));
  }

  private respond<T>(res: Response, out: { status: number; body: T; replayed: boolean }): T {
    res.status(out.status);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  }
}
