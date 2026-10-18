# payments-ledger-service

[![CI](https://github.com/kevinmakwana/payments-ledger-service/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinmakwana/payments-ledger-service/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Payments backend for **Acme Market**, a fictional marketplace: buyers pay, sellers get paid out, the platform keeps a fee. Built with NestJS, Postgres and BullMQ, and it **runs with zero API keys**: a simulated provider implements the same interface as the Stripe Connect and Razorpay drivers, down to sending HMAC-signed webhooks back to this service.

The point of the repo is the money-handling mechanics that are easy to get subtly wrong:

- a **double-entry ledger** where an unbalanced entry cannot be committed
- **idempotent** payment APIs (replays, conflicts, concurrent duplicates)
- **signed, deduplicated, retried webhooks** with a dead-letter queue
- **race-safe** capture and refund
- **payouts** with hold periods and reserves, and **reconciliation** against the provider's books

## Quick start

Requires Node 20+ and Docker.

```bash
cp .env.example .env            # optional; change POSTGRES_PORT / REDIS_PORT if 5432 / 6379 are taken
docker compose up -d --wait     # Postgres 16 + Redis 7 (host ports are configurable)
npm ci
npm run demo                    # full offline flow, prints balances (truncates the ledger tables!)
npm run start:dev               # API on :3000, OpenAPI docs on http://localhost:3000/docs
```

If you changed the ports, export matching `DATABASE_URL` / `REDIS_URL` (see `.env.example`). Migrations run automatically on startup.

`npm run demo` charges two buyers, splits the fee, refunds part of one payment, shows the payout hold, pays the seller out, then runs reconciliation, first clean, then after tampering with the provider's books so you can see the mismatch report.

## Flows

### Charge flow

```mermaid
sequenceDiagram
    autonumber
    participant B as Buyer / Client
    participant API as POST /payments
    participant DB as Postgres
    participant P as Provider (simulated / Stripe / Razorpay)
    participant Q as BullMQ
    B->>API: POST /payments (Idempotency-Key, capture=true)
    API->>DB: BEGIN; insert idempotency key (blocks concurrent duplicates)
    API->>DB: insert payment (created)
    API->>P: authorize
    API->>DB: payment -> authorized
    API->>DB: lock payment row (FOR UPDATE)
    API->>P: capture
    API->>DB: ledger entry: Dr clearing 100 / Cr seller 90 / Cr fees 10
    API->>DB: payment -> captured; store response; COMMIT
    API-->>B: 201 payment
    P--)API: POST /webhooks/simulated (HMAC-signed payment.captured)
    API->>API: verify signature + timestamp tolerance
    API->>DB: insert webhook_events (dedupe on provider+event id)
    API->>Q: enqueue (retries, exponential backoff)
    API-->>P: 202
    Q->>DB: worker marks capture confirmed by provider
    Note over Q,DB: after N failed attempts the event is dead-lettered
```

### Payout flow

```mermaid
sequenceDiagram
    autonumber
    participant S as Daily scheduler (BullMQ job scheduler)
    participant PS as Payouts service
    participant DB as Postgres
    participant Q as BullMQ
    participant P as Provider
    S->>PS: run-batch (02:00 UTC)
    PS->>DB: per seller: lock balance row, sum matured credits - debits - reserve
    PS->>DB: payout (pending) + ledger: Dr seller payable / Cr payouts in transit
    PS->>Q: enqueue dispatch
    Q->>P: createPayout (attempt n)
    alt provider pays
        P--)PS: signed payout.paid webhook
        PS->>DB: Dr in transit / Cr clearing; payout -> paid
    else provider fails
        P--)PS: signed payout.failed webhook
        alt attempts left
            PS->>Q: re-dispatch after exponential backoff
        else retries exhausted
            PS->>DB: Dr in transit / Cr seller payable (reversal); payout -> failed
        end
    end
```

## API

Interactive docs at `/docs` (OpenAPI via `@nestjs/swagger`).

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/payments` | Create and authorize a payment, optionally `capture: true`. Requires `Idempotency-Key`. |
| GET | `/payments/:id` | Fetch a payment. |
| POST | `/payments/:id/capture` | Capture an authorized payment; posts the fee split to the ledger. `Idempotency-Key` optional: with it, a retry replays the first response instead of returning `409`. |
| POST | `/payments/:id/refunds` | Full or partial refund (`amount` optional). Requires `Idempotency-Key`. |
| POST | `/webhooks/:provider` | Provider webhook intake (HMAC + timestamp tolerance, dedupe, async processing). |
| GET | `/webhooks/dead-letters` | Events that exhausted their retries. |
| POST | `/webhooks/dead-letters/:provider/:eventId/retry` | Re-queue a dead-lettered event. |
| POST | `/payouts/run` | Run the payout batch now (`asOf` optional, for backfills/demos). |
| GET | `/payouts`, `/payouts/:id` | List / fetch payouts. |
| GET | `/sellers/:sellerId/balance` | Ledger balance and the amount available for payout. |
| GET | `/reports/reconciliation?date=YYYY-MM-DD` | Provider vs ledger mismatch report for a UTC day. |
| GET | `/ledger/trial-balance` | All balances plus proof that postings sum to zero. |
| GET | `/ledger/accounts/:code` | One account's balance (cached and derived). |
| GET | `/health/live` | Liveness: the process is serving. Never touches dependencies. |
| GET | `/health/ready`, `/health` | Readiness: `200` when Postgres and Redis answer, `503` with per-dependency `up`/`down` otherwise. |

## Correctness guarantees

**Ledger**
- Every money movement is a journal entry made of signed postings in integer minor units with a currency. No floats anywhere. Fee math uses `BigInt` internally because `fee * amount` can exceed 2^53 (a property test found this).
- A **deferred constraint trigger** rejects, at `COMMIT`, any entry that has fewer than two postings or does not sum to zero per currency. App code cannot bypass it, and the e2e suite issues raw SQL to prove it.
- Postings are append-only (update/delete trigger) and must match their account's currency (composite foreign key).
- Balances are derived from postings; a cached `account_balances` row is updated **in the same transaction**. `/ledger/trial-balance` recomputes from postings and reports whether the cache agrees. Account rows are always touched in a fixed order to avoid deadlocks.
- Each ledger event has a unique `reference_key` (e.g. `capture:<payment id>`), so posting twice is a no-op.

**Idempotency**
- The key row is inserted in the *same transaction* as the work. A concurrent duplicate blocks on that insert, then replays the stored response (header `Idempotent-Replayed: true`); a rolled-back attempt leaves no trace, so the key stays usable.
- The request body is hashed canonically (key order independent). Same key with a different body returns `409`.

**State machine and concurrency**
- `created → authorized → captured → partially_refunded/refunded`; every other transition is rejected with `409`.
- Capture and refund lock the payment row (`SELECT … FOR UPDATE`) and also check a `version` column on update. 20 parallel captures produce exactly one capture and one ledger entry; parallel refunds can never exceed the captured amount.
- Partial refunds return the fee pro rata on the *cumulative* refunded amount, so any sequence of refunds sums to exactly the original fee.

**Webhooks**
- HMAC-SHA256 over the raw request bytes with a constant-time compare; signed timestamp must be within the tolerance window (replay protection). Forged signature `401`, stale or malformed `400`.
- Deduped by `(provider, event id)`. If a first delivery stored the event but failed to enqueue, a redelivery re-enqueues it (deterministic job ids prevent double jobs).
- Processed asynchronously with exponential backoff; after the last attempt the event is marked `dead` and added to the dead-letter queue. Handlers are idempotent.

**Payouts and reconciliation**
- Payable = credits older than the hold period − all debits − reserve, floored at zero. Concurrent batches serialize on the seller's balance row.
- **Payouts go back out through the provider that took the money.** The seller-level total (and its single reserve) is unchanged, but it is split into one payout per provider, largest first, and a provider is never asked to pay out more than it took in for that seller (a refund counts against the provider of its payment, a payout against the provider that carried it). A leg below `PAYOUT_MIN_MINOR` is skipped and left for a later run. Note for existing databases: payouts created before this change were all attributed to the default provider, so on a database that already paid out money taken by another provider, the first run could pay that money out again; start from a clean ledger or reconcile first.
- Payout state is `pending → paid | failed`; failed payouts retry with backoff, and permanent failure reverses the ledger entry so the money returns to the seller.
- Reconciliation matches provider transactions to ledger entries by provider reference and reports `missing_in_ledger`, `missing_at_provider` and `amount_mismatch`.

**Known simplifications** (deliberate, see Next steps): the provider call happens inside the DB transaction (a crash between a provider success and our commit is exactly what reconciliation exists to catch); a refund can drive a seller balance negative after payout; a single provider fee model; reconciliation buckets by UTC day of creation, so events near midnight can show as one-day timing differences.

## Authentication

Set `API_KEYS="<key>:<role>,<key>:<role>"` (keys of 16+ characters; roles `client` or `admin`) and every route requires `Authorization: Bearer <key>` (or `X-API-Key: <key>`). Comparison is constant-time. A malformed `API_KEYS` stops the app at startup.

| Role | Can call |
| --- | --- |
| `client` | `/payments*`, `/sellers/:id/balance` |
| `admin` | everything a client can, plus `/payouts*`, `/ledger/*`, `/reports/*`, `/webhooks/dead-letters*` |
| *(no key needed)* | `/health/*`, `/docs`, and `POST /webhooks/:provider` (authenticated by the provider's HMAC signature) |

Missing or unknown key: `401 {"code":"unauthorized"}`. Client key on an admin route: `403 {"code":"forbidden"}`.

With `API_KEYS` unset, authentication is **off** and the app logs a warning at startup (this keeps `npm run demo` and local dev frictionless). With `NODE_ENV=production` the app refuses to start without keys unless you set `ALLOW_UNAUTHENTICATED=true` on purpose. Keys live in the environment for now; hashed, rotatable keys in the database are a natural next step.

## Operations

- **Health:** point liveness probes at `/health/live` and readiness probes at `/health/ready`. A dependency outage fails readiness (traffic stops) but not liveness (no restart loop). Responses say which dependency is down, never why; the reason is in the logs.
- **Provider timeouts:** every Stripe/Razorpay call has a deadline (`PROVIDER_TIMEOUT_MS`, default 15 s) covering the connection and the response body. Provider calls run inside DB transactions, so a hung provider would otherwise hold row locks and pool connections. A timeout returns `504 provider_timeout` and rolls back; retrying with the same `Idempotency-Key` is safe.
- **Alerts:** every alert is logged as one `ALERT {json}` error line and, if `ALERT_WEBHOOK_URL` is set, POSTed as JSON (`service`, `at`, `kind`, `severity`, `message`, `details`). Alerting never fails or stalls the job that raised it. Kinds:
  - `reconciliation_mismatch` (critical): the nightly reconciliation found mismatches.
  - `webhook_dead_lettered` (warning): an event exhausted its retries.
  - `webhook_dlq_depth` (warning): dead letters at or above `ALERT_DLQ_THRESHOLD`.
  - `ledger_drift` (critical): cached balances disagree with postings, or postings do not sum to zero.

  The last two come from a monitor job (`MONITOR_CRON`, default every 15 minutes, UTC) that runs on the same shared schedule as the other jobs.
- **Retention:** a daily job (`MAINTENANCE_CRON`, default 04:00 UTC) deletes, in small batches, idempotency keys older than `IDEMPOTENCY_KEY_TTL_HOURS` (default 168 = 7 days; a client reusing a key after that would create a duplicate, so keep it longer than any client retry window) and *processed* webhook events older than `WEBHOOK_RETENTION_DAYS` (default 30; far longer than providers retry deliveries, and handlers are idempotent anyway). Events still `received` or dead-lettered are never purged.
- **Edge protection:** `helmet` security headers (CSP is off because this is a JSON API and Swagger UI needs inline scripts); JSON bodies over `BODY_LIMIT` (default `256kb`) get `413`; each client IP may make `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` (default 300 per minute) before `429` with `Retry-After`. Limiting is keyed by IP, not API key, and runs *before* authentication, so guessing keys is throttled and presenting a different key never buys a fresh budget. `/health/*` and provider webhooks are exempt. Counters are in memory, so the limit is per instance; behind a load balancer set `TRUST_PROXY` to the number of proxy hops so the real client IP is used.
- **Payout sweeper:** every `PAYOUT_SWEEP_CRON` (default 10 min) a job looks for payouts the happy path lost. A `pending` payout with no provider reference for longer than `PAYOUT_STALE_MS` (default 30 min; keep it well above `PAYOUT_RETRY_BACKOFF_MS`) had its dispatch job lost, so it is re-dispatched; rows are claimed atomically so overlapping sweeps cannot double-enqueue. A payout the provider accepted but never reported on for `PAYOUT_AWAITING_PROVIDER_MS` (default 24 h) raises a `payout_awaiting_provider` critical alert on every sweep until someone resolves it. It is deliberately not retried, because retrying could pay twice.
- **Reconciliation listings are paginated** against Stripe (`starting_after`) and Razorpay (`skip`/`count`). A day with more than 500 pages fails loudly instead of being silently truncated.

## Testing

```bash
npm test            # unit tests: state machine, signatures, payout math, reconciliation, ledger properties (no services needed)
npm run test:e2e    # e2e against real Postgres + Redis; skipped locally unless DATABASE_URL and REDIS_URL are set, but a hard FAILURE when CI=true
npm run test:e2e:cov # e2e with a coverage gate (statements 80%, branches 60%, functions 80%, lines 82%; lcov in ./coverage)
npm run typecheck && npm run lint && npm run build
```

Coverage is measured on the e2e run, because that is the suite that exercises the real app (about 86% of statements; unit tests alone cover the pure logic, about 27%). CI fails below the gate and uploads the lcov report as an artifact. Raise the thresholds in `test/jest-e2e.json` as coverage grows.

**Failure injection** (`test/failure-injection.e2e-spec.ts`) breaks a step of a flow and asserts what remains: a crash after the provider captured but before our commit rolls everything back, leaves the idempotency key reusable and shows up in reconciliation as `missing_in_ledger`; a refund that dies before commit changes nothing; provider errors and timeouts (`504`) leave no trace; a webhook that was stored but never enqueued is picked up by its redelivery. The "payout batch committed but its dispatch job was lost" crash is covered by the sweeper tests.

Covered: ledger balance property tests (pure and over random capture/refund sequences against the DB), idempotency replay/conflict/concurrent duplicates, webhook signature, tolerance, dedupe, retry and dead-letter, state machine, payout calculation with holds and reserve, payout retry and reversal, reconciliation mismatches, and the parallel capture/refund concurrency tests.

```bash
POSTGRES_PORT=5442 REDIS_PORT=6390 docker compose up -d --wait
DATABASE_URL=postgres://ledger:ledger@localhost:5442/ledger REDIS_URL=redis://localhost:6390 npm run test:e2e
```

## Dependency audit

`npm audit --omit=dev` is clean. `@nestjs/swagger@11.4.7` pins `js-yaml` 5.3.0, which has a moderate advisory (GHSA-r3ph-w7gj-g6xm, CPU use when *parsing* YAML merge keys). Swagger only calls `dump` on our own OpenAPI document, so it is not reachable, but `overrides` in `package.json` moves that one dependency to the patched 5.5.0 anyway, without the breaking Nest 12 upgrade `npm audit fix --force` would require. Drop the override when Swagger bumps its pin. The remaining `npm audit` findings are `js-yaml` 3.x inside Jest's coverage tooling (dev only, reads this repo's own config, no 3.x fix exists).

## Providers

| Driver | Needs | Notes |
| --- | --- | --- |
| `simulated` (default) | nothing | Keeps its own books and delivers signed webhooks to `/webhooks/simulated`. Payouts for seller ids starting `fail_` always fail, `flaky_` fail once. |
| `stripe` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Connect: PaymentIntents with manual capture, Refunds, Transfers to `acct_…` sellers. |
| `razorpay` | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_X_ACCOUNT_NUMBER` (payouts) | Verifies Checkout payments, captures, refunds, RazorpayX payouts (with the mandatory `X-Payout-Idempotency` header, derived per payout attempt). |

The Stripe and Razorpay drivers implement the same `PaymentProvider` interface and their signature/normalisation paths are unit-tested, but they have **not been exercised against the live APIs** (no keys in CI).

## Configuration

All via environment variables, see [.env.example](.env.example): fee (`PLATFORM_FEE_BPS`), `PAYOUT_HOLD_DAYS`, `PAYOUT_RESERVE_MINOR`, `PAYOUT_MIN_MINOR`, `PAYOUT_MAX_ATTEMPTS`, webhook tolerance / attempts / backoff, and `SCHEDULERS_ENABLED`.

Auth: `API_KEYS`, `ALLOW_UNAUTHENTICATED`. Edge: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `BODY_LIMIT`, `TRUST_PROXY`. Retention: `IDEMPOTENCY_KEY_TTL_HOURS`, `WEBHOOK_RETENTION_DAYS`, `MAINTENANCE_CRON`. Payout sweeper: `PAYOUT_STALE_MS`, `PAYOUT_AWAITING_PROVIDER_MS`, `PAYOUT_SWEEP_CRON`. Operational settings: `PROVIDER_TIMEOUT_MS`, `HEALTH_CHECK_TIMEOUT_MS`, `ALERT_WEBHOOK_URL`, `ALERT_TIMEOUT_MS`, `ALERT_DLQ_THRESHOLD`, `MONITOR_CRON`. `STRIPE_API_BASE` / `RAZORPAY_API_BASE` override the provider API URLs (used by the tests to point the real drivers at a local fake server).

## Next steps

- Transactional outbox for provider calls (authorize/capture outside the DB transaction, reconciled via the outbox state)
- Multi-currency payouts and FX postings; per-seller reserve policies
- Chargebacks/disputes as ledger events; negative-balance recovery
- Per-tenant API keys stored hashed in the database, key rotation, and a shared (Redis) rate-limit store
- Reconciliation: a mismatch resolution workflow and auto-matching of late webhooks (reports are already persisted per provider and day, and mismatches raise an alert)
- Metrics and tracing (queue depth, DLQ size, ledger drift); DLQ depth and ledger drift already alert through the monitor job

## License

MIT © Kevin Makwana
