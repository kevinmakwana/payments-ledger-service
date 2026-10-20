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

## Phase 2: Safety
- [x] **T9** Payout sweeper: re-dispatch stale pending payouts with no provider ref, alert on payouts awaiting a provider result too long, fix the dispatch job id
- [x] **T10** API-key authentication with an admin role (admin-only: `/payouts/run`, DLQ endpoints, `/ledger/*`)
- [x] **T11** Rate limiting, `helmet` and a body-size limit
- [x] **T12** TTL cleanup for `idempotency_keys` and retention for processed `webhook_events`; optional `Idempotency-Key` on capture
- [x] **T13** Payouts use the provider that took the payment (plus Razorpay payout idempotency header)
- [x] **T14** Failure-injection tests (crash after provider call / after commit); e2e fails loudly in CI when env vars are missing
- [x] **T15** Coverage reporting with a threshold; investigate the `npm audit` findings

## Phase 3: Architecture
- [x] **T16** Transactional outbox: provider calls (authorize / capture / refund) run outside the DB transaction, durable `provider_operations`, deterministic provider idempotency keys, lease-based recovery worker
- [x] **T17** Payment lifecycle: `failed`, `voiding`, `voided`, `expired` states, void endpoint, authorization expiry, persisted failed attempts (402)
- [x] **T18** Failure, dispute and chargeback webhooks as ledger events, with negative-balance recovery
- [x] **T19** Structured logging with request IDs, global exception filter, Prometheus metrics, tracing
- [x] **T20** Pagination and filters on list endpoints; new read APIs for payments, journal entries and account statements
- [x] **T21** Dockerfile, production deployment config, separate worker process mode


## Phase 4: Platform hardening
- [x] **T22** OpenTelemetry: export spans over OTLP (HTTP server, provider calls, provider operations, DB, BullMQ jobs) with trace context carried through the queues
- [x] **T23** Shared Redis rate-limit store, so limits hold across instances (falls back to in-memory if Redis is down)
- [ ] **T24** Hashed, rotatable API keys: database-backed keys stored as SHA-256, create / list / revoke / rotate endpoints, hashed keys in `API_KEYS`
