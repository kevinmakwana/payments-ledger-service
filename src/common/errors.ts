import { ConflictException, GatewayTimeoutException, UnprocessableEntityException } from '@nestjs/common';

/** A provider HTTP call exceeded PROVIDER_TIMEOUT_MS. The surrounding transaction rolls back; callers may retry with the same Idempotency-Key. */
export class ProviderTimeoutError extends GatewayTimeoutException {
  constructor(provider: string, timeoutMs: number) {
    super({ code: 'provider_timeout', message: `${provider} did not respond within ${timeoutMs}ms` });
  }
}

export class IllegalTransitionError extends ConflictException {
  constructor(from: string, to: string) {
    super({ code: 'illegal_transition', message: `Cannot move payment from ${from} to ${to}` });
  }
}

export class IdempotencyConflictError extends ConflictException {
  constructor() {
    super({
      code: 'idempotency_key_reuse',
      message: 'Idempotency-Key was already used with a different request body',
    });
  }
}

export class InvalidAmountError extends UnprocessableEntityException {
  constructor(message: string) {
    super({ code: 'invalid_amount', message });
  }
}

/** Thrown for "not yet" conditions while handling a webhook (e.g. our DB has not committed the payment yet): the queue retries with backoff. */
export class RetryableWebhookError extends Error {}
