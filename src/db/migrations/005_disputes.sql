-- Disputes (chargebacks). The ledger side lives in journal entries kinds dispute_opened / dispute_won / dispute_lost.
CREATE TABLE disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  provider     text NOT NULL,
  provider_ref text NOT NULL,                       -- the provider's dispute id
  amount       bigint NOT NULL CHECK (amount > 0),
  currency     char(3) NOT NULL,
  fee_part     bigint NOT NULL CHECK (fee_part >= 0), -- platform fee share of the disputed amount (pro rata)
  status       text NOT NULL CHECK (status IN ('open','won','lost')),
  reason       text,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX disputes_payment_idx ON disputes (payment_id);
CREATE INDEX disputes_open_idx ON disputes (opened_at) WHERE status = 'open';

-- Webhooks refer to payments by the provider's id.
CREATE INDEX payments_provider_ref_idx ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
