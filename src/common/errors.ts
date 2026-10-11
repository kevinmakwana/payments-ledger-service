import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

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
