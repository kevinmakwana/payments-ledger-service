import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { providerFeeAdjustmentLines, providerFeeLines } from './entries';
import { LedgerService } from './ledger.service';

/**
 * Brings the ledger's record of what a provider charged for a payment in line with the provider's own figure.
 * The fee normally arrives with the capture response; for providers that compute it later (Stripe's balance
 * transaction is created asynchronously) reconciliation books it afterwards through here.
 */
@Injectable()
export class ProviderFeesService {
  private readonly logger = new Logger(ProviderFeesService.name);

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
  ) {}

  /** Sets the booked fee for a payment to `fee` (minor units): posts the first booking, or the difference. Idempotent. Returns the change. */
  async setFee(paymentId: string, fee: number, currency: string, externalRef: string): Promise<{ delta: number }> {
    if (!Number.isSafeInteger(fee) || fee < 0) throw new Error(`Invalid provider fee ${fee}`);
    return this.db.tx(async (client) => {
      // Serialise concurrent adjustments for the same payment.
      await client.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      const cur = await client.query<{ fee: number; n: number }>(
        `SELECT COALESCE(sum(p.amount), 0)::bigint AS fee, count(DISTINCT e.id)::int AS n
           FROM journal_entries e
           JOIN postings p ON p.entry_id = e.id
           JOIN accounts a ON a.id = p.account_id AND a.code LIKE 'platform:provider_fees:%'
          WHERE e.payment_id = $1 AND e.kind IN ('provider_fee', 'provider_fee_adjustment')`,
        [paymentId],
      );
      const { fee: booked, n } = cur.rows[0];
      const delta = fee - booked;
      if (delta === 0) return { delta: 0 };
      const first = n === 0;
      await this.ledger.post(client, {
        kind: first ? 'provider_fee' : 'provider_fee_adjustment',
        // The first booking shares its key with the capture-time posting, so the two can never both apply.
        referenceKey: first ? `provider_fee:${paymentId}` : `provider_fee_adjustment:${paymentId}:${n}`,
        externalRef,
        paymentId,
        description: first ? `Provider fee for payment ${paymentId}` : `Provider fee adjustment for payment ${paymentId} (${booked} -> ${fee})`,
        lines: first ? providerFeeLines({ currency, amount: fee }) : providerFeeAdjustmentLines({ currency, delta }),
      });
      this.logger.log({ msg: 'provider_fee_booked', paymentId, fee, delta });
      return { delta };
    });
  }
}
