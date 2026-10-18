import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { InvalidAmountError } from '../common/errors';
import { cumulativeFeeRefund, feeFor } from '../common/money';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { IdempotencyService, StoredResponse } from '../idempotency/idempotency.service';
import { captureLines, refundLines } from '../ledger/entries';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { CreatePaymentDto } from './payments.dto';
import { assertTransition, PaymentStatus, statusAfterRefund } from './state-machine';

interface PaymentRow {
  id: string;
  buyer_id: string;
  seller_id: string;
  amount: number;
  fee_amount: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  provider_ref: string | null;
  refunded_amount: number;
  fee_refunded: number;
  version: number;
  capture_confirmed_at: Date | null;
  created_at: Date;
}

export const toView = (p: PaymentRow) => ({
  id: p.id,
  buyerId: p.buyer_id,
  sellerId: p.seller_id,
  amount: p.amount,
  feeAmount: p.fee_amount,
  currency: p.currency.trim(),
  status: p.status,
  provider: p.provider,
  providerRef: p.provider_ref,
  refundedAmount: p.refunded_amount,
  version: p.version,
  captureConfirmedByProvider: p.capture_confirmed_at !== null,
  createdAt: p.created_at.toISOString(),
});
export type PaymentView = ReturnType<typeof toView>;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly providers: ProviderRegistry,
    private readonly idempotency: IdempotencyService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Create + authorize (and optionally capture) a payment, exactly once per Idempotency-Key. */
  create(dto: CreatePaymentDto, idempotencyKey: string) {
    return this.idempotency.run<PaymentView>('POST /payments', idempotencyKey, dto, async (client) => {
      const providerName = dto.provider ?? this.config.defaultProvider;
      const provider = this.providers.get(providerName);
      const id = randomUUID();
      const fee = feeFor(dto.amount, this.config.platformFeeBps);
      await client.query(
        `INSERT INTO payments (id, buyer_id, seller_id, amount, fee_amount, currency, status, provider)
         VALUES ($1,$2,$3,$4,$5,$6,'created',$7)`,
        [id, dto.buyerId, dto.sellerId, dto.amount, fee, dto.currency, providerName],
      );
      assertTransition('created', 'authorized');
      const { providerRef } = await provider.authorize({
        paymentId: id,
        amount: dto.amount,
        currency: dto.currency,
        idempotencyKey: `${idempotencyKey}:authorize`,
        paymentMethod: dto.paymentMethod,
      });
      await client.query(
        `UPDATE payments SET status = 'authorized', provider_ref = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, providerRef],
      );
      if (dto.capture) await this.captureLocked(client, id);
      return { status: 201, body: toView(await this.lock(client, id)) };
    });
  }

  async get(id: string): Promise<PaymentView> {
    const r = await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payment ${id} not found`);
    return toView(r.rows[0]);
  }

  /**
   * Capture. The payment row is locked with SELECT ... FOR UPDATE, so concurrent captures
   * serialize: the first wins, the rest see `captured` and are rejected as illegal transitions.
   */
  capture(id: string): Promise<PaymentView>;
  /** With an Idempotency-Key, a retried capture replays the first result instead of failing with 409. */
  capture(id: string, idempotencyKey: string): Promise<StoredResponse<PaymentView> & { replayed: boolean }>;
  capture(id: string, idempotencyKey?: string) {
    if (idempotencyKey === undefined) {
      return this.db.tx(async (client) => {
        await this.captureLocked(client, id);
        return toView(await this.lock(client, id));
      });
    }
    return this.idempotency.run<PaymentView>(`POST /payments/${id}/capture`, idempotencyKey, {}, async (client) => {
      await this.captureLocked(client, id);
      return { status: 200, body: toView(await this.lock(client, id)) };
    });
  }

  /**
   * Refund (partial or full). Locks the payment row, so concurrent refunds can never
   * collectively exceed the captured amount.
   */
  refund(id: string, amount: number | undefined, idempotencyKey: string) {
    return this.idempotency.run<PaymentView>(`POST /payments/${id}/refunds`, idempotencyKey, { amount: amount ?? null }, async (client) => {
      const p = await this.lock(client, id);
      const refundable = p.amount - p.refunded_amount;
      const refundAmount = amount ?? refundable;
      if (p.status !== 'captured' && p.status !== 'partially_refunded') {
        assertTransition(p.status, 'partially_refunded'); // throws: nothing captured to refund
      }
      if (refundAmount <= 0 || refundAmount > refundable) {
        throw new InvalidAmountError(`Refund of ${refundAmount} exceeds refundable amount ${refundable}`);
      }
      const refundedTotal = p.refunded_amount + refundAmount;
      const target = statusAfterRefund(p.amount, refundedTotal);
      assertTransition(p.status, target);

      const feeRefundedTotal = cumulativeFeeRefund(p.fee_amount, p.amount, refundedTotal);
      const feeRefund = feeRefundedTotal - p.fee_refunded;
      const refundId = randomUUID();
      const { refundRef } = await this.providers.get(p.provider).refund({
        refundId,
        providerRef: p.provider_ref!,
        amount: refundAmount,
        currency: p.currency.trim(),
      });
      await this.ledger.post(client, {
        kind: 'refund',
        referenceKey: `refund:${refundId}`,
        externalRef: refundRef,
        paymentId: id,
        description: `Refund ${refundAmount} of payment ${id}`,
        lines: refundLines({ sellerId: p.seller_id, currency: p.currency.trim(), amount: refundAmount, feeRefund }),
      });
      await client.query(
        'INSERT INTO refunds (id, payment_id, amount, fee_amount, provider_ref) VALUES ($1,$2,$3,$4,$5)',
        [refundId, id, refundAmount, feeRefund, refundRef],
      );
      await this.update(client, p, { status: target, refunded_amount: refundedTotal, fee_refunded: feeRefundedTotal });
      return { status: 201, body: toView(await this.lock(client, id)) };
    });
  }

  private async captureLocked(client: PoolClient, id: string): Promise<void> {
    const p = await this.lock(client, id);
    assertTransition(p.status, 'captured');
    const currency = p.currency.trim();
    const { reportedRef } = await this.providers.get(p.provider).capture({
      paymentId: id,
      providerRef: p.provider_ref!,
      amount: p.amount,
      currency,
    });
    await this.ledger.post(client, {
      kind: 'capture',
      referenceKey: `capture:${id}`,
      externalRef: reportedRef,
      paymentId: id,
      description: `Capture payment ${id}`,
      lines: captureLines({ sellerId: p.seller_id, currency, amount: p.amount, fee: p.fee_amount }),
    });
    await this.update(client, p, { status: 'captured' });
  }

  private async lock(client: PoolClient, id: string): Promise<PaymentRow> {
    const r = await client.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payment ${id} not found`);
    return r.rows[0];
  }

  /** Optimistic version check on top of the row lock: defence in depth against lost updates. */
  private async update(client: PoolClient, p: PaymentRow, set: Partial<Pick<PaymentRow, 'status' | 'refunded_amount' | 'fee_refunded'>>) {
    const next = { status: p.status, refunded_amount: p.refunded_amount, fee_refunded: p.fee_refunded, ...set };
    const r = await client.query(
      `UPDATE payments SET status=$3, refunded_amount=$4, fee_refunded=$5, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $2`,
      [p.id, p.version, next.status, next.refunded_amount, next.fee_refunded],
    );
    if (r.rowCount !== 1) throw new ConflictException({ code: 'version_conflict', message: 'Payment was modified concurrently' });
  }
}
