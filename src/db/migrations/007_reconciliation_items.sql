-- One row per discrepancy between a provider's books and ours, with a lifecycle, so mismatches are tracked until
-- they are resolved instead of only appearing in a per-day report that the next run overwrites.
CREATE TABLE reconciliation_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('charge', 'refund', 'payout')),
  ref             text NOT NULL,                 -- the provider's id for the transaction
  date            date NOT NULL,                 -- the UTC day the discrepancy belongs to
  type            text NOT NULL CHECK (type IN ('missing_in_ledger', 'missing_at_provider', 'amount_mismatch', 'fee_mismatch')),
  currency        char(3) NOT NULL,
  provider_amount bigint,
  ledger_amount   bigint,
  entry_id        uuid,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolution      text CHECK (resolution IN ('auto_matched', 'ignored', 'fee_booked')),
  note            text,
  resolved_by     text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (provider, kind, ref)
);
CREATE INDEX reconciliation_items_status_idx ON reconciliation_items (status, first_seen_at);
CREATE INDEX reconciliation_items_day_idx ON reconciliation_items (provider, date);
CREATE INDEX reconciliation_items_created_idx ON reconciliation_items (first_seen_at DESC, id DESC);
