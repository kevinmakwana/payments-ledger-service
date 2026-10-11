-- Double-entry ledger -------------------------------------------------------
-- Amounts are integer minor units (bigint). Postings are signed:
--   amount > 0  => debit,   amount < 0 => credit.
-- Every journal entry must sum to zero per currency (enforced at COMMIT).

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                 -- e.g. seller:acme_bikes:USD
  type        text NOT NULL CHECK (type IN ('asset','liability','revenue','expense')),
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, currency)
);

CREATE TABLE journal_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  reference_key text NOT NULL UNIQUE,               -- ledger-level idempotency
  external_ref  text,                               -- provider transaction id
  payment_id    uuid,
  payout_id     uuid,
  description   text,
  effective_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_created_idx ON journal_entries (created_at);
CREATE INDEX journal_entries_external_idx ON journal_entries (external_ref);

CREATE TABLE postings (
  id          bigserial PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES journal_entries(id),
  account_id  uuid NOT NULL,
  currency    char(3) NOT NULL,
  amount      bigint NOT NULL CHECK (amount <> 0),
  FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency)
);
CREATE INDEX postings_entry_idx ON postings (entry_id);
CREATE INDEX postings_account_idx ON postings (account_id);

-- Cached balance (signed sum of postings), updated in the same transaction.
CREATE TABLE account_balances (
  account_id  uuid PRIMARY KEY REFERENCES accounts(id),
  balance     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Postings are append-only.
CREATE FUNCTION postings_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'postings are immutable (% attempted)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER postings_no_update_delete
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION postings_immutable();

-- Balanced-entry check: deferred so all postings of an entry can be inserted
-- first; it fires at COMMIT, so an unbalanced entry can never be persisted.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  bad record;
  n   int;
BEGIN
  SELECT count(*) INTO n FROM postings WHERE entry_id = NEW.entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least 2 postings (has %)', NEW.entry_id, n
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT currency, sum(amount) AS total INTO bad
    FROM postings WHERE entry_id = NEW.entry_id
    GROUP BY currency HAVING sum(amount) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal entry % is unbalanced in % (sum=%)', NEW.entry_id, bad.currency, bad.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER postings_entry_balanced
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Payments ------------------------------------------------------------------
CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          text NOT NULL,
  seller_id         text NOT NULL,
  amount            bigint NOT NULL CHECK (amount > 0),
  fee_amount        bigint NOT NULL CHECK (fee_amount >= 0 AND fee_amount <= amount),
  currency          char(3) NOT NULL,
  status            text NOT NULL CHECK (status IN
                      ('created','authorized','captured','partially_refunded','refunded')),
  provider          text NOT NULL,
  provider_ref      text,
  refunded_amount   bigint NOT NULL DEFAULT 0,
  fee_refunded      bigint NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 0,
  capture_confirmed_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_amount >= 0 AND refunded_amount <= amount)
);
CREATE INDEX payments_seller_idx ON payments (seller_id);

CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id    uuid NOT NULL REFERENCES payments(id),
  amount        bigint NOT NULL CHECK (amount > 0),
  fee_amount    bigint NOT NULL,
  provider_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key             text NOT NULL,
  scope           text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Webhooks ------------------------------------------------------------------
CREATE TABLE webhook_events (
  provider      text NOT NULL,
  event_id      text NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received','processed','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  PRIMARY KEY (provider, event_id)
);

-- Payouts -------------------------------------------------------------------
CREATE TABLE payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     text NOT NULL,
  amount        bigint NOT NULL CHECK (amount > 0),
  currency      char(3) NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','paid','failed')),
  provider      text NOT NULL,
  provider_ref  text,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_seller_idx ON payouts (seller_id);

-- Reconciliation ------------------------------------------------------------
CREATE TABLE reconciliation_reports (
  provider    text NOT NULL,
  date        date NOT NULL,
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, date)
);

-- What the simulated provider "reports" (its own books, separate from ours).
CREATE TABLE sim_provider_transactions (
  id          text PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('charge','refund','payout')),
  amount      bigint NOT NULL,
  currency    char(3) NOT NULL,
  parent_ref  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
