import { Injectable } from '@nestjs/common';
import { RetryableWebhookError } from '../common/errors';
import { DbService } from '../db/db.service';
import { DisputesService } from '../disputes/disputes.service';
import { PaymentsService } from '../payments/payments.service';
import { PayoutsService } from '../payouts/payouts.service';
import { WebhookEvent } from '../providers/provider.interface';

@Injectable()
export class WebhookHandlers {
  constructor(
    private readonly db: DbService,
    private readonly payouts: PayoutsService,
    private readonly disputes: DisputesService,
    private readonly payments: PaymentsService,
  ) {}

  async handle(provider: string, event: WebhookEvent): Promise<void> {
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
      case 'payment.failed':
        await this.payments.failFromProvider(provider, event.data.providerRef, event.data.reason);
        return;
      case 'dispute.opened':
        await this.disputes.open(provider, event);
        return;
      case 'dispute.won':
      case 'dispute.lost':
        await this.disputes.resolve(provider, event, event.type === 'dispute.won' ? 'won' : 'lost');
        return;
      case 'payout.paid':
      case 'payout.failed':
        if (!event.data.payoutId) throw new Error('payout event without payoutId');
        await this.payouts.applyProviderResult(event.data.payoutId, event.type === 'payout.paid' ? 'paid' : 'failed', {
          payoutRef: event.data.payoutRef,
          reason: event.data.reason,
        });
        return;
      default:
        return; // unknown event types (and dispute inquiries) are stored for audit and acknowledged, but need no action
    }
  }
}
