-- Lets the retention purge find old closed reconciliation items without scanning the whole table.
CREATE INDEX reconciliation_items_closed_idx ON reconciliation_items (resolved_at) WHERE status IN ('resolved', 'ignored');
