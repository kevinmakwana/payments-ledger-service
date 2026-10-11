import {
  BadRequestException, Controller, Get, HttpCode, Param, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { WebhookVerificationError } from '../providers/provider.interface';
import { ProviderRegistry } from '../providers/provider.registry';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly webhooks: WebhooksService,
  ) {}

  @Post(':provider')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Receive a provider webhook',
    description:
      'Verifies the HMAC signature and timestamp tolerance over the raw body, dedupes by event id, then queues the event for async processing (retries + exponential backoff + dead-letter queue).',
  })
  async receive(@Param('provider') provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    const driver = this.providers.get(provider);
    if (!req.rawBody) throw new BadRequestException('Raw body unavailable');
    let event;
    try {
      event = driver.parseWebhook(req.rawBody, req.headers);
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        if (err.code === 'missing_signature' || err.code === 'invalid_signature') {
          throw new UnauthorizedException({ code: err.code, message: err.message });
        }
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }
    const { duplicate } = await this.webhooks.receive(provider, event);
    return { received: true, duplicate };
  }

  @Get('dead-letters')
  @ApiOperation({ summary: 'Webhook events that exhausted their retries' })
  deadLetters() {
    return this.webhooks.deadLetters();
  }

  @Post('dead-letters/:provider/:eventId/retry')
  @HttpCode(202)
  @ApiOperation({ summary: 'Re-queue a dead-lettered webhook event' })
  retry(@Param('provider') provider: string, @Param('eventId') eventId: string) {
    return this.webhooks.retryDeadLetter(provider, eventId);
  }
}
