# Improvement backlog

## Phase 1: Quick wins
- [x] **T1** Provider HTTP timeouts (`PROVIDER_TIMEOUT_MS`, `AbortSignal.timeout`) for Stripe + Razorpay, mapped to a retryable error
- [x] **T2** Stripe payout idempotency key per attempt
- [x] **T3** Paginate `listTransactions` for Stripe and Razorpay
- [x] **T4** Real `/health` readiness check (Postgres + Redis) plus a liveness route
- [x] **T5** Alert hook for reconciliation mismatches, DLQ depth and ledger cache drift
- [x] **T6** `GET /ledger/accounts/:code` queries one account instead of the full trial balance
- [x] **T7** Migration 002: indexes on `webhook_events(status)`, `payments(status)`, `payouts(status, updated_at)`
- [x] **T8** Fix stale README line about persisted reconciliation reports
