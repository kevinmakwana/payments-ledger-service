-- Transactional outbox for provider calls + the fuller payment lifecycle.

-- Payment states: `capturing` / `voiding` are in-flight (a provider call is pending or being retried);
-- failed / voided / expired are terminal.
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN
  ('created','authorized','capturing','captured','partially_refunded','refunded','failed','voiding','voided','expired'));
ALTER TABLE payments
  ADD COLUMN capture_requested boolean NOT NULL DEFAULT false,   -- create-with-capture: capture as soon as authorized
  ADD COLUMN authorized_at timestamptz,
  ADD COLUMN failure_code text,
  ADD COLUMN failure_message text;
UPDATE payments SET authorized_at = created_at WHERE status <> 'created';
-- Expiry sweep: authorized payments ordered by age.
CREATE INDEX payments_authorized_idx ON payments (authorized_at) WHERE status = 'authorized';
-- Recovery sweep: payments stuck in an in-flight state.
CREATE INDEX payments_inflight_idx ON payments (updated_at) WHERE status IN ('created','capturing','voiding');

-- Refunds are reserved first (pending) and only counted against the payment once the provider confirms.
ALTER TABLE refunds
  ADD COLUMN status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending','succeeded','failed')),
  ADD COLUMN failure_message text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE refunds ALTER COLUMN fee_amount SET DEFAULT 0;
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_pending_idx ON refunds (updated_at) WHERE status = 'pending';

-- A key whose first request committed its short "intent" transaction but has not stored a response yet
-- points at the resource to resume (see IdempotencyService.runDurable).
ALTER TABLE idempotency_keys ADD COLUMN resource_id text;

-- The outbox. One row per provider call we intend to make. `idempotency_key` is what the provider sees, so any
-- re-execution (client retry, recovery worker, lease expiry after a crash) converges on a single provider-side effect.
CREATE TABLE provider_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id      uuid NOT NULL REFERENCES payments(id),
  refund_id       uuid REFERENCES refunds(id),
  kind            text NOT NULL CHECK (kind IN ('authorize','capture','refund','void')),
  provider        text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','succeeded','failed')),
  result          jsonb,
  error_code      text,
  error_message   text,
  attempts        integer NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_operations_payment_idx ON provider_operations (payment_id, kind);
CREATE INDEX provider_operations_open_idx ON provider_operations (updated_at) WHERE status IN ('pending','in_flight');
