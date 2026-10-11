import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { WebhookEvent } from '../providers/provider.interface';
import { PayoutsService } from '../payouts/payouts.service';

/** Thrown for "not yet" conditions (e.g. our DB hasn't committed the capture): the queue retries with backoff. */
export class RetryableWebhookError extends Error {}

@Injectable()
export class WebhookHandlers {
  constructor(
    private readonly db: DbService,
    private readonly payouts: PayoutsService,
  ) {}

  async handle(event: WebhookEvent): Promise<void> {
    switch (event.type) {
      case 'payment.captured': {
        const r = await this.db.query(
          `UPDATE payments SET capture_confirmed_at = COALESCE(capture_confirmed_at, now())
            WHERE id = $1 AND status IN ('captured','partially_refunded','refunded')`,
          [event.data.paymentId],
        );
        if (r.rowCount === 0) throw new RetryableWebhookError(`Payment ${event.data.paymentId} not captured in our DB yet`);
        return;
      }
      case 'payment.refunded': {
        const r = await this.db.query('SELECT 1 FROM refunds WHERE provider_ref = $1', [event.data.refundRef]);
        if (r.rowCount === 0) throw new RetryableWebhookError(`Refund ${event.data.refundRef} not recorded yet`);
        return;
      }
      case 'payout.paid':
      case 'payout.failed':
        if (!event.data.payoutId) throw new Error('payout event without payoutId');
        await this.payouts.applyProviderResult(event.data.payoutId, event.type === 'payout.paid' ? 'paid' : 'failed', {
          payoutRef: event.data.payoutRef,
          reason: event.data.reason,
        });
        return;
      default:
        return; // unknown event types are stored (audit) and acknowledged, but need no action
    }
  }
}
