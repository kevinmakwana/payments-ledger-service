/**
 * The contract every payment provider driver implements. Webhook payloads are
 * normalised by each driver into the canonical event types below, so the rest of
 * the system never sees Stripe/Razorpay-specific shapes.
 */
export type CanonicalEventType = 'payment.captured' | 'payment.refunded' | 'payout.paid' | 'payout.failed';

export interface WebhookEvent {
  id: string;
  type: CanonicalEventType | string; // unknown provider events are stored but ignored
  /** Unix seconds as reported by the provider. */
  createdAt: number;
  data: {
    paymentId?: string;
    payoutId?: string;
    providerRef?: string;
    refundRef?: string;
    payoutRef?: string;
    amount?: number;
    reason?: string;
  };
}

export interface ProviderTransaction {
  /** Provider's id for the money movement (charge / refund / payout). */
  id: string;
  type: 'charge' | 'refund' | 'payout';
  amount: number;
  currency: string;
  parentRef?: string;
  createdAt: string; // ISO-8601
}

export interface AuthorizeRequest {
  paymentId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  /** Provider-specific payment method token (Stripe pm_..., Razorpay pay_...). Ignored by the simulator. */
  paymentMethod?: string;
}

export interface PaymentProvider {
  readonly name: string;
  authorize(req: AuthorizeRequest): Promise<{ providerRef: string }>;
  /** `reportedRef` is the id this provider uses for the captured charge in its transaction reports. */
  capture(req: { paymentId: string; providerRef: string; amount: number; currency: string }): Promise<{ reportedRef: string }>;
  refund(req: { refundId: string; providerRef: string; amount: number; currency: string }): Promise<{ refundRef: string }>;
  createPayout(req: {
    payoutId: string;
    sellerId: string;
    amount: number;
    currency: string;
    attempt: number;
  }): Promise<{ payoutRef: string }>;
  /** Transactions the provider reports for a UTC calendar day (YYYY-MM-DD). */
  listTransactions(date: string): Promise<ProviderTransaction[]>;
  /** Verify signature + timestamp tolerance and return the normalised event. Throws WebhookVerificationError. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, nowSeconds?: number): WebhookEvent;
}

export class WebhookVerificationError extends Error {
  constructor(
    readonly code: 'missing_signature' | 'invalid_signature' | 'stale_timestamp' | 'malformed_payload',
    message: string,
  ) {
    super(message);
  }
}
