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

The provider is never called inside a database transaction. A short transaction records the *intent* (the payment and a row in the `provider_operations` outbox); the provider call then runs outside any transaction with a deterministic idempotency key; a second short transaction applies the result (state change and ledger posting) atomically. Every step is idempotent and state-driven, so a crash anywhere is repaired by driving the payment forward again.

```mermaid
sequenceDiagram
    autonumber
    participant B as Buyer / Client
    participant API as POST /payments
    participant DB as Postgres
    participant P as Provider (simulated / Stripe / Razorpay)
    participant R as Recovery worker
    B->>API: POST /payments (Idempotency-Key, capture=true)
    API->>DB: tx 1: insert idempotency key + payment (created) + outbox op authorize:ID; COMMIT
    API->>DB: claim op (in_flight, with a lease)
    API->>P: authorize (idempotency key authorize:ID, no DB transaction held)
    alt declined
        API->>DB: tx 2: payment -> failed (recorded), op failed
        API-->>B: 402 payment_declined (replayed for the same key)
    else authorized
        API->>DB: tx 2: payment -> authorized, op succeeded
        API->>DB: tx 3: payment -> capturing + outbox op capture:ID:1
        API->>P: capture (idempotency key capture:ID:1)
        API->>DB: tx 4: ledger entry Dr clearing 100 / Cr seller 90 / Cr fees 10; payment -> captured
        API-->>B: 201 payment
    end
    Note over API,R: crash, timeout or unknown outcome at any point: the op stays pending/in_flight
    R->>DB: payments idle in created / capturing / voiding, refunds pending
    R->>P: same call, same idempotency key (provider returns the same result)
    R->>DB: apply result once
    Note over B,API: a retry with the same Idempotency-Key resumes the same payment instead of starting over
```

Webhook intake and processing are described under *Webhooks* below.

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
| POST | `/payments` | Create and authorize a payment, optionally `capture: true`. Requires `Idempotency-Key`. `402` if declined (the failed attempt is recorded); `504` if the provider timed out (retry with the same key). |
| GET | `/payments` | List payments, newest first. Filters: `sellerId`, `buyerId`, `status`, `provider`, `createdFrom`, `createdTo`. |
| GET | `/payments/:id` | Fetch a payment. |
| POST | `/payments/:id/capture` | Capture an authorized payment; posts the fee split to the ledger. `Idempotency-Key` optional: with it, a retry replays the first response instead of returning `409`. |
| POST | `/payments/:id/void` | Cancel an authorized payment. `Idempotency-Key` optional. |
| POST | `/payments/:id/refunds` | Full or partial refund (`amount` optional). Requires `Idempotency-Key`. |
| POST | `/webhooks/:provider` | Provider webhook intake (HMAC + timestamp tolerance, dedupe, async processing). |
| GET | `/webhooks/dead-letters` | Events that exhausted their retries (paginated). |
| POST | `/webhooks/dead-letters/:provider/:eventId/retry` | Re-queue a dead-lettered event. |
| POST | `/payouts/run` | Run the payout batch now (`asOf` optional, for backfills/demos). |
| GET | `/payouts` | List payouts, newest first. Filters: `sellerId`, `status`, `provider`. |
| GET | `/payouts/:id` | Fetch a payout. |
| GET | `/disputes` | List disputes (chargebacks). Filters: `status`, `paymentId`, `provider`. |
| GET | `/sellers/:sellerId/balance` | Ledger balance and the amount available for payout. |
| GET | `/reports/reconciliation?date=YYYY-MM-DD` | Provider vs ledger mismatch report for a UTC day. |
| GET | `/ledger/trial-balance` | All balances plus proof that postings sum to zero. |
| GET | `/ledger/accounts/:code` | One account's balance (cached and derived). |
| GET | `/ledger/accounts/:code/statement` | The account's postings, newest first, each with the running balance after it. |
| GET | `/ledger/entries` | Journal entries with their postings. Filters: `kind`, `paymentId`, `payoutId`, `accountCode`, `from`, `to`. |
| POST, GET, DELETE | `/admin/api-keys`, `/admin/api-keys/:id/rotate` | Issue, list, rotate and revoke API keys (admin only). See Authentication. |
| GET | `/metrics` | Prometheus metrics. Admin key required. |
| GET | `/health/live` | Liveness: the process is serving. Never touches dependencies. |
| GET | `/health/ready`, `/health` | Readiness: `200` when Postgres and Redis answer, `503` with per-dependency `up`/`down` otherwise. |

### Pagination

Every list endpoint returns `{ "data": [...], "nextCursor": "..." | null }` and accepts `?limit=` (1 to 200, default 50) and `?cursor=` (pass the previous `nextCursor`). Pagination is **keyset**, not offset: a cursor encodes the sort key of the last row, so pages neither skip nor repeat rows when new ones arrive between requests, and deep pages cost the same as the first. Cursors are opaque; a tampered or malformed one is `400 invalid_cursor`. Unknown query parameters and invalid filter values are `400`. Account statements carry the running balance in the cursor, so `balanceAfter` chains exactly across pages even while new postings arrive.

**Breaking change from the earlier API:** `GET /payouts` and `GET /webhooks/dead-letters` used to return a bare array capped at 200; they now return the envelope above.

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
- `created → authorized → capturing → captured → partially_refunded/refunded`, plus `created → failed` (declined), `authorized → voiding → voided | expired`; every other transition is rejected with `409`. `created`, `capturing` and `voiding` are *in flight*: a provider call is pending or being retried.
- A declined authorization is **recorded** (status `failed`, `failureCode`, `failureMessage`) and answered `402 payment_declined`; the same key replays the same `402`. A declined capture leaves the payment `authorized` (`402 capture_declined`); a declined refund is `422 refund_rejected` and releases its reservation. Only a *definitive* refusal (declined card, invalid request) counts as a decline. Timeouts, 5xx, 429 and bad credentials mean "outcome unknown": the payment stays in flight, the request answers 5xx/`504`, and a retry or the recovery worker finishes it. They are never shown to the customer as a decline.
- `POST /payments/:id/void` cancels an authorization (Stripe: cancels the PaymentIntent; Razorpay releases uncaptured authorizations itself, so it answers `422 void_rejected`). Authorizations not captured within `AUTHORIZATION_TTL_HOURS` (default 7 days) are voided automatically and marked `expired`.
- Capture and refund lock the payment row (`SELECT … FOR UPDATE`) and also check a `version` column on update. 20 parallel captures produce exactly one capture and one ledger entry (the winner moves the payment to `capturing`; the rest get `409`). A refund first *reserves* its amount as a `pending` refund row under that lock, so parallel refunds can never exceed the captured amount even while a provider call is still in flight.
- Partial refunds return the fee pro rata on the *cumulative* refunded amount, so any sequence of refunds sums to exactly the original fee.

**Webhooks**
- HMAC-SHA256 over the raw request bytes with a constant-time compare; signed timestamp must be within the tolerance window (replay protection). Forged signature `401`, stale or malformed `400`.
- Deduped by `(provider, event id)`. If a first delivery stored the event but failed to enqueue, a redelivery re-enqueues it (deterministic job ids prevent double jobs).
- Processed asynchronously with exponential backoff; after the last attempt the event is marked `dead` and added to the dead-letter queue. Handlers are idempotent.

**Disputes (chargebacks)**
- `dispute.opened`, `dispute.won` and `dispute.lost` webhooks (Stripe `charge.dispute.created` / `charge.dispute.closed`, Razorpay `payment.dispute.created` / `.won` / `.lost`) are ledger events. When the provider withdraws the money, it moves from the provider balance to `platform:disputed_funds` (a receivable) and the seller's share is withheld from their payable balance into `platform:dispute_holds`, so it cannot be paid out meanwhile; the platform fee share stays in revenue until the outcome. **Won:** everything is reversed exactly. **Lost:** the receivable is written off, the seller bears their share and the platform returns its fee share, which is exactly the effect of a refund (a property test checks this).
- Disputes are idempotent (the provider's dispute id is unique) and tolerant of ordering: an outcome that arrives before the opening, or an opening for a payment we have not committed yet, is retried by the webhook queue and dead-lettered with an alert if it never resolves. Stripe `warning_*` statuses are inquiries (no funds withdrawn) and never touch the ledger.
- Money under an open dispute, or lost to one, is excluded from what can be refunded, so it cannot be paid out twice.
- **Negative balances:** a refund or lost dispute after payout can leave a seller owing the platform. `GET /sellers/:id/balance` reports `owesPlatform`; nothing is payable until new sales cover the debt, and payouts net it automatically (new sales minus what is owed, minus the reserve). The monitor raises a `seller_negative_balance` warning so a human can decide whether to collect sooner.
- `payment.failed` (Stripe `payment_intent.payment_failed`, Razorpay `payment.failed`) marks a not-yet-captured payment `failed`. For money that was already captured it raises a critical `payment_failed_after_capture` alert and changes nothing, because money may already have moved. Not modelled yet: provider dispute fees, and Razorpay `payment.dispute.closed` / `under_review` (stored, not acted on). The Razorpay dispute payloads follow Razorpay's published docs; the `lost` sample could not be confirmed, and like the other live drivers they have not been exercised against the real API.

**Payouts and reconciliation**
- Payable = credits older than the hold period − all debits − reserve, floored at zero. Concurrent batches serialize on the seller's balance row.
- **Payouts go back out through the provider that took the money.** The seller-level total (and its single reserve) is unchanged, but it is split into one payout per provider, largest first, and a provider is never asked to pay out more than it took in for that seller (a refund counts against the provider of its payment, a payout against the provider that carried it). A leg below `PAYOUT_MIN_MINOR` is skipped and left for a later run. Note for existing databases: payouts created before this change were all attributed to the default provider, so on a database that already paid out money taken by another provider, the first run could pay that money out again; start from a clean ledger or reconcile first.
- Payout state is `pending → paid | failed`; failed payouts retry with backoff, and permanent failure reverses the ledger entry so the money returns to the seller.
- Reconciliation matches provider transactions to ledger entries by provider reference and reports `missing_in_ledger`, `missing_at_provider` and `amount_mismatch`.

**Known simplifications** (deliberate, see Next steps): a refund can drive a seller balance negative after payout; a single provider fee model; reconciliation buckets by UTC day of creation, so events near midnight can show as one-day timing differences.

## Authentication

Every route requires `Authorization: Bearer <key>` (or `X-API-Key: <key>`) once authentication is on. Keys come from two places:

- **Bootstrap keys in `API_KEYS`** (environment), `"<key>:<role>,<key>:<role>"` with keys of 16+ characters and roles `client` or `admin`. A key can also be given as its digest, `sha256:<64 hex chars>:<role>`, so the secret never sits in an env file or orchestrator config: `npm run key:generate` prints a fresh key with its `API_KEYS` entry (`-- hash <key> [role]` converts an existing one; in a built image run `node dist/auth/key-tool.js`). Only SHA-256 digests are held in memory either way, comparison is constant-time, and a malformed `API_KEYS` stops the app at startup. These keys never touch the database, so they keep working if it is down. Keep at least one admin bootstrap key: it is how the first database key is issued.
- **Issued keys in the database**, managed with admin-only endpoints. Tokens look like `plk_` + 43 random characters (256 bits). Only the SHA-256 is stored, plus a short non-secret prefix so a key can be recognised in a list; the secret is returned **once**, in the response that creates it.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/api-keys` | `{ name, role, expiresInDays? }` → the new key (`key` field holds the secret; store it now). |
| GET | `/admin/api-keys` | List keys, newest first (paginated): metadata, `status` (`active`, `expired`, `revoked`), `lastUsedAt`, `createdBy`. Never the secret. |
| POST | `/admin/api-keys/:id/rotate` | `{ graceSeconds? (default 86400, 0 = retire now), expiresInDays? }` → a replacement with the same name and role; the old key keeps working for the grace period, so clients can switch over without downtime. A key can be rotated once; rotate its replacement next time. |
| DELETE | `/admin/api-keys/:id` | Revoke (idempotent). |

Issued keys are cached per process for `API_KEY_CACHE_TTL_MS` (default 10 s) so authenticating costs no query: a revocation is immediate on the instance that handles it and reaches the others within that time; a key's own expiry is always honoured exactly. If the database is unreachable, an issued key gets `503 auth_unavailable` (never a silent pass); bootstrap keys still work. Every create, rotate and revoke is logged with the acting key's id (`env:<fingerprint>` for bootstrap keys, the key's uuid otherwise), and `lastUsedAt` is updated at most once a minute per key. Keys are per role, not per seller or client.

| Role | Can call |
| --- | --- |
| `client` | `/payments*`, `/sellers/:id/balance` |
| `admin` | everything a client can, plus `/payouts*`, `/ledger/*`, `/reports/*`, `/webhooks/dead-letters*` |
| *(no key needed)* | `/health/*`, `/docs`, and `POST /webhooks/:provider` (authenticated by the provider's HMAC signature) |

Missing or unknown key: `401 {"code":"unauthorized"}`. Client key on an admin route: `403 {"code":"forbidden"}`.

With `API_KEYS` unset, authentication is **off** and the app logs a warning at startup (this keeps `npm run demo` and local dev frictionless). With `NODE_ENV=production` the app refuses to start without keys unless you set `ALLOW_UNAUTHENTICATED=true` on purpose.

## Deployment

One image, two tiers. The API tier scales with request volume; the worker tier scales with queue volume; both come from the same `Dockerfile` (multi-stage, Node 22 alpine, runs as the unprivileged `node` user, about 224 MB, `node` as PID 1 so SIGTERM triggers graceful shutdown).

| `APP_ROLE` | Runs | Listens on |
| --- | --- | --- |
| `all` (default) | HTTP API and queue workers and schedulers in one process (local dev, the demo, small installs) | `PORT` (3000) |
| `api` | HTTP API only. It queues work but processes none, and never registers the scheduled jobs | `PORT` (3000) |
| `worker` | BullMQ workers and schedulers only (webhook processing, payouts, reconciliation, monitor, retention, payment recovery) | `WORKER_PORT` (3001): `/health/live`, `/health/ready` and `/metrics` (admin key if `API_KEYS` is set). **Internal only**; it is not an API |

Run any number of each. Workers are safe to scale out (BullMQ distributes jobs; scheduled jobs are registered under fixed ids so they fire once per tick however many workers exist; payout, webhook and payment operations are idempotent and claimed with leases). Migrations run at startup under a Postgres advisory lock, so several instances starting together are fine.

```bash
docker build -t payments-ledger-service .
cp deploy/prod.env.example deploy/prod.env        # fill in real secrets (git-ignored)
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --build --wait
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/prod.env up -d --scale api=3 --scale worker=2
```

[deploy/docker-compose.prod.yml](deploy/docker-compose.prod.yml) is a production-shaped stack: `api` and `worker` services, Postgres and Redis with persistent volumes (Redis with AOF and a password, because queue state and schedules live there), required secrets enforced at `up` time, nothing but the API published. `NODE_ENV=production` makes the app refuse to start without `API_KEYS` and switches logs to JSON. This stack was built and exercised end to end (payment, worker-processed webhook, worker-dispatched payout, balanced ledger, worker port unreachable from the host).

For an orchestrator: liveness `GET /health/live` and readiness `GET /health/ready` on `PORT` for `api`, and on `WORKER_PORT` for `worker`; give `worker` a longer termination grace period than `api` (in-flight jobs finish on SIGTERM); terminate TLS and put a load balancer in front of `api`, and set `TRUST_PROXY` to the number of proxy hops. Kubernetes manifests are not included because they could not be validated here. Behind separate processes the simulated provider needs `SIMULATED_WEBHOOK_BASE_URL` (the compose file sets it); real providers deliver to your public webhook URL and need nothing.

## Operations

- **Observability:**
  - *Request ids and trace context.* Every response carries `X-Request-Id` (the caller's if it is 1 to 64 chars of `[A-Za-z0-9._-]`, otherwise generated). An inbound W3C `traceparent` is continued, and the trace id is sent on outgoing provider and alert calls and appears in every log line of that request.
  - *Distributed tracing (OpenTelemetry).* Off by default; set `OTEL_EXPORTER_OTLP_ENDPOINT` (e.g. `http://otel-collector:4318`) to export spans over OTLP/HTTP, using the standard `OTEL_*` variables (`OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER` and `_ARG`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`, ...; `OTEL_SDK_DISABLED=true` is a hard off switch). One trace covers a request end to end: the `SERVER` span (named `METHOD /route/pattern`, continuing the caller's `traceparent`), a `provider_operation <kind>` span per outbox execution with a `CLIENT` span for each Stripe/Razorpay HTTP call inside it, a `db.transaction` span grouping the statement spans from the `pg` instrumentation, and BullMQ producer/worker spans, so a webhook job shows up in the trace of the request that enqueued it. Log lines carry the exported trace id. Span names and attributes never contain query strings, bodies or bind parameters. Health and metrics probes are not traced. Known noise: BullMQ's own maintenance work (`moveStalledJobsToWait`, `startStalledCheckTimer`, `close`) is exported as root spans; drop them in the collector (e.g. the `filter` processor) if you do not want them. Spans are buffered and flushed on graceful shutdown. Metrics stay on Prometheus.
  - *Logs.* `LOG_FORMAT=json` (the default when `NODE_ENV=production`) writes one JSON object per line (`ts`, `level`, `context`, `msg`, `requestId`, `traceId`); `pretty` is Nest's coloured console for local development. `LOG_LEVEL` is `info` by default. One `http_request` line per request records method, route *pattern*, status and duration; never the query string, headers or body, and health/metrics probes are not logged.
  - *Errors.* Every error has one shape: `{ "statusCode", "code", "message", "requestId", ...domain fields }`. Domain codes (`idempotency_key_reuse`, `provider_timeout`, ...) and extra fields are preserved. Anything unexpected is an opaque `500 internal_error`; the real cause and stack go to the log under the same request id, never to the client.
  - *Metrics.* `GET /metrics` (Prometheus text format, **admin key required**, so give your scraper `authorization` credentials). Counters and histograms: `http_requests_total` and `http_request_duration_seconds` (labelled by route pattern, never raw ids), `provider_calls_total{provider,operation,outcome=success|rejected|error}`, `provider_call_duration_seconds`, `alerts_total{kind,severity}`, `rate_limit_store_fallbacks_total`. Gauges computed at scrape time from Postgres/Redis: `queue_jobs{queue,state}` (all queues including the webhook dead-letter queue), `webhook_events_dead`, `payments_in_flight{status}`, `provider_operations_open{status}`, `payouts_pending`; `ledger_consistent` (1/0, from the last monitor run); plus the default process metrics. Good starting alerts: `webhook_events_dead > 0`, `ledger_consistent == 0`, `payments_in_flight` or `provider_operations_open` not draining, and the `error` outcome rate of `provider_calls_total`.
- **Health:** point liveness probes at `/health/live` and readiness probes at `/health/ready`. A dependency outage fails readiness (traffic stops) but not liveness (no restart loop). Responses say which dependency is down, never why; the reason is in the logs.
- **Provider timeouts:** every Stripe/Razorpay call has a deadline (`PROVIDER_TIMEOUT_MS`, default 15 s) covering the connection and the response body. Provider calls run inside DB transactions, so a hung provider would otherwise hold row locks and pool connections. A timeout returns `504 provider_timeout` and rolls back; retrying with the same `Idempotency-Key` is safe.
- **Alerts:** every alert is logged as one `ALERT {json}` error line and, if `ALERT_WEBHOOK_URL` is set, POSTed as JSON (`service`, `at`, `kind`, `severity`, `message`, `details`). Alerting never fails or stalls the job that raised it. Kinds:
  - `reconciliation_mismatch` (critical): the nightly reconciliation found mismatches.
  - `webhook_dead_lettered` (warning): an event exhausted its retries.
  - `webhook_dlq_depth` (warning): dead letters at or above `ALERT_DLQ_THRESHOLD`.
  - `seller_negative_balance` (warning): sellers owe the platform money after a refund or lost dispute.
  - `payment_failed_after_capture` (critical): the provider reported a failure for money that was already captured.
  - `ledger_drift` (critical): cached balances disagree with postings, or postings do not sum to zero.

  The last two come from a monitor job (`MONITOR_CRON`, default every 15 minutes, UTC) that runs on the same shared schedule as the other jobs.
- **Outbox and recovery:** each provider call is a `provider_operations` row claimed with a lease (`PROVIDER_OP_LEASE_MS`, default 60 s; a claim older than that is treated as a crashed executor and taken over). A recovery job (`PAYMENT_RECOVERY_CRON`, default every minute) drives payments and refunds that have been idle for `PAYMENT_RECOVERY_AGE_MS` (default 60 s) to completion, expires stale authorizations, and raises a `provider_operation_stuck` critical alert for operations still open after `PROVIDER_OP_MAX_ATTEMPTS` (default 10) attempts. Provider idempotency keys are deterministic (`authorize:<payment>`, `capture:<payment>:<attempt>`, `refund:<refund>`, `void:<payment>:<attempt>`; capture and void are per attempt because a provider replays the saved result of a reused key, even a failed one).
- **Retention:** a daily job (`MAINTENANCE_CRON`, default 04:00 UTC) deletes, in small batches, idempotency keys older than `IDEMPOTENCY_KEY_TTL_HOURS` (default 168 = 7 days; a client reusing a key after that would create a duplicate, so keep it longer than any client retry window) and *processed* webhook events older than `WEBHOOK_RETENTION_DAYS` (default 30; far longer than providers retry deliveries, and handlers are idempotent anyway). Events still `received` or dead-lettered are never purged.
- **Edge protection:** `helmet` security headers (CSP is off because this is a JSON API and Swagger UI needs inline scripts); JSON bodies over `BODY_LIMIT` (default `256kb`) get `413`; each client IP may make `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` (default 300 per minute) before `429` with `Retry-After`. Limiting is keyed by IP, not API key, and runs *before* authentication, so guessing keys is throttled and presenting a different key never buys a fresh budget. `/health/*` and provider webhooks are exempt. With `RATE_LIMIT_STORE=redis` (what the production compose stack uses) the counters live in Redis, updated by one atomic Lua script per request, so the limit is global across every API instance; the default `memory` counts per instance. Redis is called with its own fail-fast connection and a `RATE_LIMIT_STORE_TIMEOUT_MS` deadline (default 250 ms): if it is down or slow, requests are counted in memory instead of being rejected or delayed (availability over exactness), a warning is logged at most every 30 s, and `rate_limit_store_fallbacks_total` counts them, so alert on that. Behind a load balancer set `TRUST_PROXY` to the number of proxy hops so the real client IP is used.
- **Payout sweeper:** every `PAYOUT_SWEEP_CRON` (default 10 min) a job looks for payouts the happy path lost. A `pending` payout with no provider reference for longer than `PAYOUT_STALE_MS` (default 30 min; keep it well above `PAYOUT_RETRY_BACKOFF_MS`) had its dispatch job lost, so it is re-dispatched; rows are claimed atomically so overlapping sweeps cannot double-enqueue. A payout the provider accepted but never reported on for `PAYOUT_AWAITING_PROVIDER_MS` (default 24 h) raises a `payout_awaiting_provider` critical alert on every sweep until someone resolves it. It is deliberately not retried, because retrying could pay twice.
- **Reconciliation listings are paginated** against Stripe (`starting_after`) and Razorpay (`skip`/`count`). A day with more than 500 pages fails loudly instead of being silently truncated.

## Testing

```bash
npm test            # unit tests: state machine, signatures, payout math, reconciliation, ledger properties (no services needed)
npm run test:e2e    # e2e against real Postgres + Redis; skipped locally unless DATABASE_URL and REDIS_URL are set, but a hard FAILURE when CI=true
npm run test:e2e:cov # e2e with a coverage gate (statements 84%, branches 66%, functions 83%, lines 87%; lcov in ./coverage)
npm run typecheck && npm run lint && npm run build
```

Coverage is measured on the e2e run, because that is the suite that exercises the real app (about 88% of statements; unit tests alone cover the pure logic). CI fails below the gate and uploads the lcov report as an artifact. Raise the thresholds in `test/jest-e2e.json` as coverage grows.

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

Auth: `API_KEYS`, `API_KEY_CACHE_TTL_MS`, `ALLOW_UNAUTHENTICATED`. Process: `APP_ROLE`, `WORKER_PORT`, `SIMULATED_WEBHOOK_BASE_URL`. Logging: `LOG_FORMAT`, `LOG_LEVEL`. Edge: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_STORE`, `RATE_LIMIT_STORE_TIMEOUT_MS`, `BODY_LIMIT`, `TRUST_PROXY`. Tracing: `OTEL_EXPORTER_OTLP_ENDPOINT` and the other standard `OTEL_*` variables. Outbox: `PROVIDER_OP_LEASE_MS`, `PROVIDER_OP_MAX_ATTEMPTS`, `PAYMENT_RECOVERY_AGE_MS`, `PAYMENT_RECOVERY_CRON`, `AUTHORIZATION_TTL_HOURS`. Retention: `IDEMPOTENCY_KEY_TTL_HOURS`, `WEBHOOK_RETENTION_DAYS`, `MAINTENANCE_CRON`. Payout sweeper: `PAYOUT_STALE_MS`, `PAYOUT_AWAITING_PROVIDER_MS`, `PAYOUT_SWEEP_CRON`. Operational settings: `PROVIDER_TIMEOUT_MS`, `HEALTH_CHECK_TIMEOUT_MS`, `ALERT_WEBHOOK_URL`, `ALERT_TIMEOUT_MS`, `ALERT_DLQ_THRESHOLD`, `MONITOR_CRON`. `STRIPE_API_BASE` / `RAZORPAY_API_BASE` override the provider API URLs (used by the tests to point the real drivers at a local fake server).

## Next steps

- Multi-currency payouts and FX postings; per-seller reserve policies
- Per-tenant API keys scoped to a seller or client (keys today carry a role, not a tenant)
- Reconciliation: a mismatch resolution workflow and auto-matching of late webhooks (reports are already persisted per provider and day, and mismatches raise an alert)

## License

MIT © Kevin Makwana
