-- Support the retention job's batched deletes (see MaintenanceService).
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
-- Partial: only processed events are ever purged, and they are the bulk of the table.
CREATE INDEX IF NOT EXISTS webhook_events_processed_idx ON webhook_events (processed_at) WHERE status = 'processed';
