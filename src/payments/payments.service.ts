import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { IllegalTransitionError, InvalidAmountError, RetryableWebhookError } from '../common/errors';
import { cumulativeFeeRefund, feeFor } from '../common/money';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AlertService } from '../alerts/alert.service';
import { DbService } from '../db/db.service';
import { IdempotencyService, StoredResponse } from '../idempotency/idempotency.service';
import { captureLines, providerFeeLines, refundLines } from '../ledger/entries';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decodeCursor, isPgTimestamp, isUuid, Page, pageOf, resolveLimit, Where } from '../common/pagination';
import { CreatePaymentDto, ListPaymentsQuery } from './payments.dto';
import { OpRow, Outcome, ProviderOpsService } from './provider-ops.service';
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
  capture_requested: boolean;
  authorized_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
  capture_confirmed_at: Date | null;
  created_at: Date;
}

interface RefundRow {
  id: string;
  payment_id: string;
  amount: number;
  fee_amount: number;
  status: 'pending' | 'succeeded' | 'failed';
  failure_message: string | null;
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
  failureCode: p.failure_code,
  failureMessage: p.failure_message,
  version: p.version,
  captureConfirmedByProvider: p.capture_confirmed_at !== null,
  createdAt: p.created_at.toISOString(),
});
export type PaymentView = ReturnType<typeof toView>;

/** Columns a state change may touch (a whitelist: they are interpolated into SQL). */
type Settable = 'status' | 'provider_ref' | 'authorized_at' | 'failure_code' | 'failure_message' | 'capture_requested' | 'refunded_amount' | 'fee_refunded';

type Response<T = unknown> = StoredResponse<T>;
type Done<T = unknown> = Response<T> & { replayed: boolean };

/**
 * Payments, built on the transactional outbox:
 *  - a short DB transaction records the intent (payment/refund row + a provider operation);
 *  - the provider call runs OUTSIDE any transaction (ProviderOpsService), with a deterministic idempotency key;
 *  - its result is applied atomically (state change + ledger posting) in `applyOutcome`.
 * Because every step is idempotent and state-driven, a crash at any point is repaired by simply driving the payment
 * forward again (`advance`), from a client retry with the same Idempotency-Key or from the recovery worker.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly providers: ProviderRegistry,
    private readonly ops: ProviderOpsService,
    private readonly idempotency: IdempotencyService,
    private readonly alerts: AlertService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -- create -------------------------------------------------------------------------------------------------------

  /** Create + authorize (and optionally capture) a payment, exactly once per Idempotency-Key. */
  create(dto: CreatePaymentDto, idempotencyKey: string): Promise<Done> {
    return this.idempotency.runDurable('POST /payments', idempotencyKey, dto, {
      start: async (client) => {
        const providerName = dto.provider ?? this.config.defaultProvider;
        this.providers.get(providerName); // unknown / unconfigured provider -> 400, nothing recorded
        const id = randomUUID();
        await client.query(
          `INSERT INTO payments (id, buyer_id, seller_id, amount, fee_amount, currency, status, provider, capture_requested)
           VALUES ($1,$2,$3,$4,$5,$6,'created',$7,$8)`,
          [id, dto.buyerId, dto.sellerId, dto.amount, feeFor(dto.amount, this.config.platformFeeBps), dto.currency, providerName, dto.capture === true],
        );
        await this.ops.enqueue(client, {
          paymentId: id,
          kind: 'authorize',
          provider: providerName,
          idempotencyKey: `authorize:${id}`,
          request: { amount: dto.amount, currency: dto.currency, paymentMethod: dto.paymentMethod },
        });
        return id;
      },
      finish: async (id) => {
        await this.advance(id);
        return this.createResponse(id);
      },
    });
  }

  private async createResponse(id: string): Promise<Response> {
    const p = await this.read(id);
    if (p.status === 'failed') {
      return { status: 402, body: { code: 'payment_declined', message: p.failure_message, payment: toView(p) } };
    }
    if (p.status === 'authorized' && (await this.lastOpFailed(id, 'capture'))) {
      const op = await this.latestOp(id, 'capture');
      return { status: 402, body: { code: 'capture_declined', message: op?.error_message ?? 'Capture was declined', payment: toView(p) } };
    }
    return { status: 201, body: toView(p) };
  }

  /** Newest first, keyset-paginated (stable while new payments arrive), with optional filters. */
  async list(q: ListPaymentsQuery): Promise<Page<PaymentView>> {
    const limit = resolveLimit(q.limit);
    const cursor = decodeCursor<{ t: string; i: string }>(q.cursor, { t: 'string', i: 'string' }, (c) => isPgTimestamp(c.t) && isUuid(c.i));
    const w = new Where();
    if (q.sellerId) w.add('seller_id = ?', q.sellerId);
    if (q.buyerId) w.add('buyer_id = ?', q.buyerId);
    if (q.status) w.add('status = ?', q.status);
    if (q.provider) w.add('provider = ?', q.provider);
    if (q.createdFrom) w.add('created_at >= ?::timestamptz', q.createdFrom);
    if (q.createdTo) w.add('created_at < ?::timestamptz', q.createdTo);
    if (cursor) w.addMany('(created_at, id) < (?1::timestamptz, ?2::uuid)', [cursor.t, cursor.i]);
    const rows = await this.db.query<PaymentRow & { cursor_ts: string }>(
      `SELECT *, created_at::text AS cursor_ts FROM payments ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ${w.param(limit + 1)}`,
      w.params,
    );
    const page = pageOf(rows.rows, limit, (r) => ({ t: r.cursor_ts, i: r.id }));
    return { data: page.data.map(toView), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<PaymentView> {
    const r = await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payment ${id} not found`);
    return toView(r.rows[0]);
  }

  // -- capture ------------------------------------------------------------------------------------------------------

  /**
   * Capture an authorized payment. The row lock + the `authorized -> capturing` transition serialize concurrent
   * captures: exactly one wins, the others get 409. With an Idempotency-Key, a retry resumes/replays instead.
   */
  async capture(id: string, idempotencyKey?: string): Promise<Done> {
    if (idempotencyKey === undefined) {
      const op = await this.db.tx((client) => this.beginCapture(client, id));
      return { ...(await this.finishCapture(op.id)), replayed: false };
    }
    return this.idempotency.runDurable(`POST /payments/${id}/capture`, idempotencyKey, {}, {
      start: async (client) => (await this.beginCapture(client, id)).id,
      finish: (opId) => this.finishCapture(opId),
    });
  }

  private async beginCapture(client: PoolClient, id: string): Promise<OpRow> {
    const p = await this.lock(client, id);
    assertTransition(p.status, 'capturing');
    const attempt = (await this.ops.countOps(client, id, 'capture')) + 1;
    const op = await this.ops.enqueue(client, {
      paymentId: id,
      kind: 'capture',
      provider: p.provider,
      // Per attempt: a provider replays the saved result of a reused key, even a failed one.
      idempotencyKey: `capture:${id}:${attempt}`,
      request: { providerRef: p.provider_ref, amount: p.amount, currency: p.currency.trim() },
    });
    await this.setPayment(client, p, { status: 'capturing' });
    return op;
  }

  private async finishCapture(opId: string): Promise<Response> {
    const op = await this.ops.execute(opId, this.applyOutcome);
    const p = await this.read(op.payment_id);
    if (op.status === 'failed') {
      return { status: 402, body: { code: 'capture_declined', message: op.error_message, payment: toView(p) } };
    }
    return { status: 200, body: toView(p) };
  }

  // -- void / expire ------------------------------------------------------------------------------------------------

  /** Cancel an authorization that will not be captured. */
  async void(id: string, idempotencyKey?: string): Promise<Done> {
    if (idempotencyKey === undefined) {
      const op = await this.db.tx((client) => this.beginVoid(client, id, 'voided'));
      return { ...(await this.finishVoid(op.id)), replayed: false };
    }
    return this.idempotency.runDurable(`POST /payments/${id}/void`, idempotencyKey, {}, {
      start: async (client) => (await this.beginVoid(client, id, 'voided')).id,
      finish: (opId) => this.finishVoid(opId),
    });
  }

  /** Used by the recovery worker for authorizations nobody captured in time. */
  async expire(id: string): Promise<void> {
    const op = await this.db.tx((client) => this.beginVoid(client, id, 'expired'));
    await this.ops.execute(op.id, this.applyOutcome);
  }

  private async beginVoid(client: PoolClient, id: string, reason: 'voided' | 'expired'): Promise<OpRow> {
    const p = await this.lock(client, id);
    assertTransition(p.status, 'voiding');
    const attempt = (await this.ops.countOps(client, id, 'void')) + 1;
    const op = await this.ops.enqueue(client, {
      paymentId: id,
      kind: 'void',
      provider: p.provider,
      idempotencyKey: `void:${id}:${attempt}`,
      request: { providerRef: p.provider_ref, reason },
    });
    await this.setPayment(client, p, { status: 'voiding' });
    return op;
  }

  private async finishVoid(opId: string): Promise<Response> {
    const op = await this.ops.execute(opId, this.applyOutcome);
    const p = await this.read(op.payment_id);
    if (op.status === 'failed') {
      return { status: 422, body: { code: 'void_rejected', message: op.error_message, payment: toView(p) } };
    }
    return { status: 200, body: toView(p) };
  }

  // -- refund -------------------------------------------------------------------------------------------------------

  /**
   * Refund (partial or full). The amount is reserved (a `pending` refund row) under the payment's row lock, so
   * concurrent refunds can never collectively exceed what was captured; it only counts against the payment once the
   * provider confirms.
   */
  refund(id: string, amount: number | undefined, idempotencyKey: string): Promise<Done> {
    return this.idempotency.runDurable(`POST /payments/${id}/refunds`, idempotencyKey, { amount: amount ?? null }, {
      start: async (client) => {
        const p = await this.lock(client, id);
        if (p.status !== 'captured' && p.status !== 'partially_refunded') {
          assertTransition(p.status, 'partially_refunded'); // throws: nothing captured to refund
        }
        const reserved = (await client.query<{ n: number }>(
          `SELECT COALESCE(sum(amount), 0) AS n FROM refunds WHERE payment_id = $1 AND status = 'pending'`,
          [id],
        )).rows[0].n;
        // Money under an open dispute, or already lost to one, cannot also be refunded (that would pay it out twice).
        const disputed = (await client.query<{ n: number }>(
          `SELECT COALESCE(sum(amount), 0) AS n FROM disputes WHERE payment_id = $1 AND status IN ('open','lost')`,
          [id],
        )).rows[0].n;
        const refundable = p.amount - p.refunded_amount - reserved - disputed;
        const refundAmount = amount ?? refundable;
        if (refundAmount <= 0 || refundAmount > refundable) {
          throw new InvalidAmountError(`Refund of ${refundAmount} exceeds refundable amount ${refundable}`);
        }
        assertTransition(p.status, statusAfterRefund(p.amount, p.refunded_amount + reserved + refundAmount));
        const refundId = randomUUID();
        await client.query(`INSERT INTO refunds (id, payment_id, amount, status) VALUES ($1,$2,$3,'pending')`, [refundId, id, refundAmount]);
        await this.ops.enqueue(client, {
          paymentId: id,
          refundId,
          kind: 'refund',
          provider: p.provider,
          idempotencyKey: `refund:${refundId}`,
          request: { providerRef: p.provider_ref, amount: refundAmount, currency: p.currency.trim() },
        });
        return refundId;
      },
      finish: (refundId) => this.finishRefund(refundId),
    });
  }

  /** Also used by the recovery worker for refunds whose provider call never settled. */
  async finishRefund(refundId: string): Promise<Response> {
    const op = await this.ops.findForRefund(refundId);
    if (!op) throw new NotFoundException(`No provider operation for refund ${refundId}`);
    await this.ops.execute(op.id, this.applyOutcome);
    const refund = (await this.db.query<RefundRow>('SELECT * FROM refunds WHERE id = $1', [refundId])).rows[0];
    const p = await this.read(refund.payment_id);
    if (refund.status === 'failed') {
      return { status: 422, body: { code: 'refund_rejected', message: refund.failure_message, payment: toView(p) } };
    }
    return { status: 201, body: toView(p) };
  }

  // -- provider-reported failures -----------------------------------------------------------------------------------

  /**
   * The provider says a payment failed after the fact. Before capture that ends the payment (`failed`). After capture
   * money may already have moved, so we do not guess: raise a critical alert for a human instead of touching the ledger.
   */
  async failFromProvider(provider: string, providerRef: string | undefined, reason: string | undefined): Promise<void> {
    if (!providerRef) throw new Error('payment.failed event without a payment reference');
    const outcome = await this.db.tx(async (client) => {
      const found = await client.query<PaymentRow>('SELECT * FROM payments WHERE provider = $1 AND provider_ref = $2 FOR UPDATE', [provider, providerRef]);
      const p = found.rows[0];
      if (!p) return { kind: 'unknown' as const };
      if (p.status === 'failed') return { kind: 'done' as const };
      if (p.status === 'authorized') {
        await this.setPayment(client, p, {
          status: 'failed',
          failure_code: 'provider_reported_failure',
          failure_message: reason ?? 'The provider reported this payment as failed',
          capture_requested: false,
        });
        return { kind: 'done' as const };
      }
      if (['captured', 'partially_refunded', 'refunded', 'capturing'].includes(p.status)) return { kind: 'after_capture' as const, id: p.id, status: p.status };
      return { kind: 'ignored' as const };
    });
    if (outcome.kind === 'unknown') throw new RetryableWebhookError(`No payment with ${provider} reference ${providerRef} yet`);
    if (outcome.kind === 'after_capture') {
      await this.alerts.raise({
        kind: 'payment_failed_after_capture',
        severity: 'critical',
        message: `${provider} reported payment ${outcome.id} as failed, but it is already ${outcome.status}; the ledger was not changed`,
        details: { paymentId: outcome.id, provider, providerRef, reason },
      });
    }
  }

  // -- driving a payment forward (client retry / recovery worker) ---------------------------------------------------

  /** State-driven and idempotent: performs whatever provider step the payment is waiting on, until it settles. */
  async advance(id: string): Promise<void> {
    for (let step = 0; step < 8; step++) {
      const p = await this.read(id);
      switch (p.status) {
        case 'created':
          await this.runOpenOp(id, 'authorize');
          break;
        case 'authorized':
          if (!p.capture_requested) return;
          try {
            await this.db.tx((client) => this.beginCapture(client, id));
          } catch (err) {
            if (!(err instanceof IllegalTransitionError)) throw err; // a concurrent driver already started the capture
          }
          break;
        case 'capturing':
          await this.runOpenOp(id, 'capture');
          break;
        case 'voiding':
          await this.runOpenOp(id, 'void');
          break;
        default:
          return; // settled (captured, refunded, failed, voided, expired, ...)
      }
    }
  }

  private async runOpenOp(paymentId: string, kind: 'authorize' | 'capture' | 'void'): Promise<void> {
    const op = await this.ops.findOpen(paymentId, kind);
    if (!op) {
      // Someone settled it between our read and now: loop again with fresh state.
      return;
    }
    await this.ops.execute(op.id, this.applyOutcome);
  }

  // -- applying provider outcomes (runs inside the transaction that settles the operation) --------------------------

  private readonly applyOutcome = async (client: PoolClient, op: OpRow, outcome: Outcome): Promise<void> => {
    const p = await this.lock(client, op.payment_id);
    switch (op.kind) {
      case 'authorize': {
        if (p.status !== 'created') return;
        if (outcome.ok) {
          await this.setPayment(client, p, { status: 'authorized', provider_ref: String(outcome.result.providerRef), authorized_at: new Date() });
        } else {
          await this.setPayment(client, p, { status: 'failed', failure_code: outcome.code, failure_message: outcome.message });
        }
        return;
      }
      case 'capture': {
        if (p.status !== 'capturing') return;
        if (!outcome.ok) {
          // The authorization is still good; a declined capture ends any capture-on-create intent.
          await this.setPayment(client, p, { status: 'authorized', capture_requested: false });
          return;
        }
        const currency = p.currency.trim();
        await this.ledger.post(client, {
          kind: 'capture',
          referenceKey: `capture:${p.id}`,
          externalRef: String(outcome.result.reportedRef),
          paymentId: p.id,
          description: `Capture payment ${p.id}`,
          lines: captureLines({ sellerId: p.seller_id, currency, amount: p.amount, fee: p.fee_amount }),
        });
        const providerFee = outcome.result.fee;
        if (typeof providerFee === 'number' && Number.isSafeInteger(providerFee) && providerFee > 0 && providerFee <= p.amount) {
          await this.ledger.post(client, {
            kind: 'provider_fee',
            referenceKey: `provider_fee:${p.id}`,
            externalRef: String(outcome.result.reportedRef),
            paymentId: p.id,
            description: `Provider fee for payment ${p.id}`,
            lines: providerFeeLines({ currency, amount: providerFee }),
          });
        }
        await this.setPayment(client, p, { status: 'captured' });
        return;
      }
      case 'void': {
        if (p.status !== 'voiding') return;
        if (!outcome.ok) {
          await this.setPayment(client, p, { status: 'authorized' });
        } else {
          await this.setPayment(client, p, { status: op.request.reason === 'expired' ? 'expired' : 'voided' });
        }
        return;
      }
      case 'refund': {
        const refund = (await client.query<RefundRow>('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [op.refund_id])).rows[0];
        if (refund.status !== 'pending') return;
        if (!outcome.ok) {
          await client.query(`UPDATE refunds SET status = 'failed', failure_message = $2, updated_at = now() WHERE id = $1`, [refund.id, outcome.message]);
          return;
        }
        const currency = p.currency.trim();
        const refundedTotal = p.refunded_amount + refund.amount;
        const feeRefundedTotal = cumulativeFeeRefund(p.fee_amount, p.amount, refundedTotal);
        const feeRefund = feeRefundedTotal - p.fee_refunded;
        const refundRef = String(outcome.result.refundRef);
        await this.ledger.post(client, {
          kind: 'refund',
          referenceKey: `refund:${refund.id}`,
          externalRef: refundRef,
          paymentId: p.id,
          description: `Refund ${refund.amount} of payment ${p.id}`,
          lines: refundLines({ sellerId: p.seller_id, currency, amount: refund.amount, feeRefund }),
        });
        await client.query(`UPDATE refunds SET status = 'succeeded', provider_ref = $2, fee_amount = $3, updated_at = now() WHERE id = $1`, [refund.id, refundRef, feeRefund]);
        await this.setPayment(client, p, {
          status: statusAfterRefund(p.amount, refundedTotal),
          refunded_amount: refundedTotal,
          fee_refunded: feeRefundedTotal,
        });
        return;
      }
    }
  };

  // -- helpers ------------------------------------------------------------------------------------------------------

  private async read(id: string): Promise<PaymentRow> {
    const r = await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payment ${id} not found`);
    return r.rows[0];
  }

  private async lock(client: PoolClient, id: string): Promise<PaymentRow> {
    const r = await client.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw new NotFoundException(`Payment ${id} not found`);
    return r.rows[0];
  }

  private async latestOp(paymentId: string, kind: 'capture' | 'void' | 'authorize'): Promise<OpRow | undefined> {
    const r = await this.db.query<OpRow>(
      'SELECT * FROM provider_operations WHERE payment_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1',
      [paymentId, kind],
    );
    return r.rows[0];
  }

  private async lastOpFailed(paymentId: string, kind: 'capture'): Promise<boolean> {
    return (await this.latestOp(paymentId, kind))?.status === 'failed';
  }

  /**
   * Validated state change on a row we hold the lock on. The version check is defence in depth against lost
   * updates; the transition is asserted against the state machine.
   */
  private async setPayment(client: PoolClient, p: PaymentRow, fields: Partial<Record<Settable, unknown>>): Promise<void> {
    if (fields.status !== undefined) assertTransition(p.status, fields.status as PaymentStatus);
    const columns = Object.keys(fields) as Settable[];
    const sets = columns.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const r = await client.query(
      `UPDATE payments SET ${sets}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`,
      [p.id, p.version, ...columns.map((c) => fields[c])],
    );
    if (r.rowCount !== 1) throw new ConflictException({ code: 'version_conflict', message: 'Payment was modified concurrently' });
  }
}
