-- Indexes for operational queries that otherwise scan whole tables.
-- (Plain CREATE INDEX: the migration runner wraps each file in a transaction, which rules out CONCURRENTLY.
--  On a large production table, create these by hand with CONCURRENTLY first; IF NOT EXISTS makes this a no-op then.)

-- Dead-letter listing / depth monitor: WHERE status = 'dead' ORDER BY received_at DESC.
CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events (status, received_at DESC);

-- Finding payments stuck in a state (e.g. authorized but never captured).
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status);

-- Finding payouts stuck in `pending` for too long.
CREATE INDEX IF NOT EXISTS payouts_status_updated_idx ON payouts (status, updated_at);
