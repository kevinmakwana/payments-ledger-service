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
- [x] **T24** Hashed, rotatable API keys: database-backed keys stored as SHA-256, create / list / revoke / rotate endpoints, hashed keys in `API_KEYS`
- [x] **T24a** Follow-ups: BullMQ upkeep spans filtered in code instead of in the collector; alert (`rate_limit_store_unavailable`) when the Redis rate-limit store fails over to memory

## Phase 5: Money correctness
- [x] **T25** Persisted reconciliation items with a lifecycle (open / resolved / ignored): mismatches are auto-resolved when a later run finds them matched, a lookback window re-checks recent days, and a ±1 day window stops UTC day-boundary false positives
- [x] **T26** Operator workflow for mismatches: list / get / ignore (with a required note) / reopen, alerts only on new items plus a stale-item alert, open-item metrics, and nightly reconciliation of every configured provider
- [x] **T27** Provider fee accounting: record the fee Stripe / Razorpay / the simulator charge on each capture as a ledger expense, and a margin report (platform fee revenue minus provider fees)

## Phase 6: Next up
- [ ] **T28** Provider fees on refunds, disputes and payouts: today only captures book the provider fee, so Stripe / Razorpay fees on disputes (and any non-refunded fee on refunds) never reach the ledger or the margin report
- [ ] **T29** Reconciliation item retention: purge resolved / ignored `reconciliation_items` after a configurable age, keeping open items
- [ ] **T30** Scoped API keys: per-key permissions (for example payments:write, ledger:read, payouts:run) instead of just admin / non-admin, enforced on every route and managed through the key endpoints
- [ ] **T31** Multi-currency and FX: per-currency ledger balances, FX rate source and conversion postings, and multi-currency payouts and margin reporting
- [ ] **T32** Kubernetes manifests: api and worker deployments, probes, HPA, config and secrets, alongside the existing Dockerfile
- [ ] **T33** Move the test runner from Jest to Vitest, dropping the Node 24 / `--experimental-vm-modules` requirement for tests
- [ ] **T34** Stripe and Razorpay live testing against test-mode accounts (blocked until test API keys are available)
