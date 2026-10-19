import {
  BadRequestException, Controller, Get, HttpCode, Param, Post, Query, Req, UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AdminOnly, Public } from '../auth/auth.decorators';
import { PageQuery } from '../common/pagination';
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
  @Public() // authenticated by the provider's signature, not by an API key
  @SkipThrottle() // provider retries/bursts come from a few IPs; dropping them would lose events
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
  @AdminOnly()
  @ApiOperation({ summary: 'Webhook events that exhausted their retries' })
  deadLetters(@Query() query: PageQuery) {
    return this.webhooks.deadLetters(query);
  }

  @Post('dead-letters/:provider/:eventId/retry')
  @AdminOnly()
  @HttpCode(202)
  @ApiOperation({ summary: 'Re-queue a dead-lettered webhook event' })
  retry(@Param('provider') provider: string, @Param('eventId') eventId: string) {
    return this.webhooks.retryDeadLetter(provider, eventId);
  }
}
