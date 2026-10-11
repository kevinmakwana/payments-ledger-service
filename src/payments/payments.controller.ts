import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CreatePaymentDto, RefundDto } from './payments.dto';
import { PaymentsService } from './payments.service';

const IdempotencyKeyHeader = ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: 'Unique per logical request. Replays return the stored response; reuse with a different body returns 409.',
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
  async create(
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await this.payments.create(dto, requireKey(key));
    return this.respond(res, out);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a payment' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id);
  }

  @Post(':id/capture')
  @HttpCode(200)
  @ApiOperation({ summary: 'Capture an authorized payment and post the fee split to the ledger' })
  capture(@Param('id', ParseUUIDPipe) id: string) {
    return this.payments.capture(id);
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
    const out = await this.payments.refund(id, dto.amount, requireKey(key));
    return this.respond(res, out);
  }

  private respond<T>(res: Response, out: { status: number; body: T; replayed: boolean }): T {
    res.status(out.status);
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  }
}
