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
| POST | `/payments/:id/capture` | Capture an authorized payment; posts the fee split to the ledger. |
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
- Payout state is `pending → paid | failed`; failed payouts retry with backoff, and permanent failure reverses the ledger entry so the money returns to the seller.
- Reconciliation matches provider transactions to ledger entries by provider reference and reports `missing_in_ledger`, `missing_at_provider` and `amount_mismatch`.

**Known simplifications** (deliberate, see Next steps): the provider call happens inside the DB transaction (a crash between a provider success and our commit is exactly what reconciliation exists to catch); a refund can drive a seller balance negative after payout; a single provider fee model; reconciliation buckets by UTC day of creation, so events near midnight can show as one-day timing differences.

## Operations

- **Health:** point liveness probes at `/health/live` and readiness probes at `/health/ready`. A dependency outage fails readiness (traffic stops) but not liveness (no restart loop). Responses say which dependency is down, never why; the reason is in the logs.
- **Provider timeouts:** every Stripe/Razorpay call has a deadline (`PROVIDER_TIMEOUT_MS`, default 15 s) covering the connection and the response body. Provider calls run inside DB transactions, so a hung provider would otherwise hold row locks and pool connections. A timeout returns `504 provider_timeout` and rolls back; retrying with the same `Idempotency-Key` is safe.
- **Alerts:** every alert is logged as one `ALERT {json}` error line and, if `ALERT_WEBHOOK_URL` is set, POSTed as JSON (`service`, `at`, `kind`, `severity`, `message`, `details`). Alerting never fails or stalls the job that raised it. Kinds:
  - `reconciliation_mismatch` (critical): the nightly reconciliation found mismatches.
  - `webhook_dead_lettered` (warning): an event exhausted its retries.
  - `webhook_dlq_depth` (warning): dead letters at or above `ALERT_DLQ_THRESHOLD`.
  - `ledger_drift` (critical): cached balances disagree with postings, or postings do not sum to zero.

  The last two come from a monitor job (`MONITOR_CRON`, default every 15 minutes, UTC) that runs on the same shared schedule as the other jobs.
- **Reconciliation listings are paginated** against Stripe (`starting_after`) and Razorpay (`skip`/`count`). A day with more than 500 pages fails loudly instead of being silently truncated.

## Testing

```bash
npm test            # unit tests: state machine, signatures, payout math, reconciliation, ledger properties (no services needed)
npm run test:e2e    # e2e against real Postgres + Redis; skipped unless DATABASE_URL and REDIS_URL are set
npm run typecheck && npm run lint && npm run build
```

Covered: ledger balance property tests (pure and over random capture/refund sequences against the DB), idempotency replay/conflict/concurrent duplicates, webhook signature, tolerance, dedupe, retry and dead-letter, state machine, payout calculation with holds and reserve, payout retry and reversal, reconciliation mismatches, and the parallel capture/refund concurrency tests.

```bash
POSTGRES_PORT=5442 REDIS_PORT=6390 docker compose up -d --wait
DATABASE_URL=postgres://ledger:ledger@localhost:5442/ledger REDIS_URL=redis://localhost:6390 npm run test:e2e
```

## Providers

| Driver | Needs | Notes |
| --- | --- | --- |
| `simulated` (default) | nothing | Keeps its own books and delivers signed webhooks to `/webhooks/simulated`. Payouts for seller ids starting `fail_` always fail, `flaky_` fail once. |
| `stripe` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Connect: PaymentIntents with manual capture, Refunds, Transfers to `acct_…` sellers. |
| `razorpay` | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Verifies Checkout payments, captures, refunds, RazorpayX payouts. |

The Stripe and Razorpay drivers implement the same `PaymentProvider` interface and their signature/normalisation paths are unit-tested, but they have **not been exercised against the live APIs** (no keys in CI).

## Configuration

All via environment variables, see [.env.example](.env.example): fee (`PLATFORM_FEE_BPS`), `PAYOUT_HOLD_DAYS`, `PAYOUT_RESERVE_MINOR`, `PAYOUT_MIN_MINOR`, `PAYOUT_MAX_ATTEMPTS`, webhook tolerance / attempts / backoff, and `SCHEDULERS_ENABLED`.

Operational settings: `PROVIDER_TIMEOUT_MS`, `HEALTH_CHECK_TIMEOUT_MS`, `ALERT_WEBHOOK_URL`, `ALERT_TIMEOUT_MS`, `ALERT_DLQ_THRESHOLD`, `MONITOR_CRON`. `STRIPE_API_BASE` / `RAZORPAY_API_BASE` override the provider API URLs (used by the tests to point the real drivers at a local fake server).

## Next steps

- Transactional outbox for provider calls (authorize/capture outside the DB transaction, reconciled via the outbox state)
- Multi-currency payouts and FX postings; per-seller reserve policies
- Chargebacks/disputes as ledger events; negative-balance recovery
- Auth (API keys / OAuth) and per-tenant rate limiting; admin-only access to payout and DLQ endpoints
- Reconciliation: a mismatch resolution workflow and auto-matching of late webhooks (reports are already persisted per provider and day, and mismatches raise an alert)
- Metrics and tracing (queue depth, DLQ size, ledger drift); DLQ depth and ledger drift already alert through the monitor job

## License

MIT © Kevin Makwana
