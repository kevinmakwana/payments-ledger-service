import { ApiKey, parseApiKeys } from '../auth/api-keys';

export interface AppConfig {
  /** Configured API keys; empty means authentication is disabled (never allowed in production by default). */
  apiKeys: ApiKey[];
  /** How long an API key issued through the admin API stays cached in this process; bounds how long a revocation takes to reach every instance. */
  apiKeyCacheTtlMs: number;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  queuePrefix: string;
  defaultProvider: string;
  platformFeeBps: number;
  payoutHoldDays: number;
  payoutReserveMinor: number;
  payoutMinMinor: number;
  payoutMaxAttempts: number;
  payoutRetryBackoffMs: number;
  schedulersEnabled: boolean;
  /**
   * What this process does: `api` serves HTTP only, `worker` runs the BullMQ workers and schedulers (plus a small
   * health/metrics server on `workerHealthPort`), `all` does both in one process (the default).
   */
  role: 'all' | 'api' | 'worker';
  workerHealthPort: number;
  /** Where the simulated provider POSTs its webhooks. Needed when the API and worker run in separate processes. */
  simulatedWebhookBaseUrl?: string;
  /** `json` (one structured line per event, for log pipelines) or `pretty` (Nest's coloured console). Default: json in production. */
  logFormat: 'json' | 'pretty';
  logLevel: 'verbose' | 'debug' | 'info' | 'warn' | 'error';
  /** OpenTelemetry span export is on (see src/tracing.ts). Queues then carry trace context from producer to worker. */
  tracingEnabled: boolean;
  /** A provider operation claimed longer ago than this is considered abandoned (crashed process) and can be re-claimed. */
  providerOpLeaseMs: number;
  /** Open operations with at least this many attempts raise a `provider_operation_stuck` alert. */
  providerOpMaxAttempts: number;
  /** The recovery worker only touches payments/refunds idle for at least this long (don't race live requests). */
  paymentRecoveryAgeMs: number;
  /** Cron (UTC) for the payment recovery + authorization expiry worker. */
  paymentRecoveryCron: string;
  /** An authorized payment not captured within this many hours is voided and marked `expired`. */
  authorizationTtlHours: number;
  /** Idempotency keys older than this are deleted; a client reusing a key after this window would create a duplicate. */
  idempotencyKeyTtlHours: number;
  /** Processed webhook events older than this are deleted (received and dead-lettered events are never purged). */
  webhookRetentionDays: number;
  /** Resolved and ignored reconciliation items older than this are deleted (open items are never purged). */
  reconciliationItemRetentionDays: number;
  /** The nightly reconciliation re-checks this many days ending yesterday, so a late webhook closes yesterday's open items by itself. */
  reconciliationLookbackDays: number;
  /** An open reconciliation item older than this raises a `reconciliation_item_stale` alert every night until someone resolves or ignores it. */
  reconciliationStaleDays: number;
  /** Cron (UTC) for the retention job. */
  maintenanceCron: string;
  /** Requests allowed per client IP per window before answering 429. Counted per instance. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** `redis` shares the counters across instances (a real global limit); `memory` counts per instance. */
  rateLimitStore: 'memory' | 'redis';
  /** Deadline for one rate-limit counter call; past it the request is counted in memory instead of waiting. */
  rateLimitStoreTimeoutMs: number;
  /** Largest accepted JSON request body (express/body-parser syntax, e.g. "256kb"). */
  bodyLimit: string;
  /** Number of reverse-proxy hops to trust for the client IP (X-Forwarded-For); unset = none. */
  trustProxy?: number;
  /** A pending payout with no provider ref untouched this long is considered orphaned and re-dispatched. Keep well above PAYOUT_RETRY_BACKOFF_MS. */
  payoutStaleMs: number;
  /** A payout the provider accepted but never reported on for this long raises an alert. */
  payoutAwaitingProviderMs: number;
  /** Cron (UTC) for the payout sweeper. */
  payoutSweepCron: string;
  webhookToleranceSeconds: number;
  webhookMaxAttempts: number;
  webhookBackoffMs: number;
  simulatedWebhookSecret: string;
  /** Processing fee the simulated provider charges per capture: basis points of the amount plus a fixed part (minor units). Default none. */
  simulatedFeeBps: number;
  simulatedFeeFixedMinor: number;
  /** Upper bound for one provider HTTP call (request + response body). */
  providerTimeoutMs: number;
  /** Per-dependency deadline for /health/ready. */
  healthCheckTimeoutMs: number;
  /** If set, every alert is also POSTed here as JSON (Slack-compatible incoming webhook, PagerDuty relay, ...). */
  alertWebhookUrl?: string;
  alertTimeoutMs: number;
  /** Dead-lettered webhook events at or above this count trigger an alert. */
  alertDlqThreshold: number;
  /** Cron (UTC) for the monitor job that checks DLQ depth and ledger drift. */
  monitorCron: string;
  stripeApiBase: string;
  razorpayApiBase: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Tracing is opt-in: it needs an OTLP endpoint (standard OTEL_* variables) and is hard-disabled by OTEL_SDK_DISABLED=true. */
export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED === 'true') return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

const int = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Expected integer env value, got "${v}"`);
  return n;
};

function rateLimitStore(v: string | undefined): 'memory' | 'redis' {
  if (v === undefined || v === '') return 'memory';
  if (v !== 'memory' && v !== 'redis') throw new Error(`RATE_LIMIT_STORE must be memory or redis (got "${v}")`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const role = env.APP_ROLE ?? 'all';
  if (role !== 'all' && role !== 'api' && role !== 'worker') throw new Error(`APP_ROLE must be all, api or worker (got "${role}")`);
  const apiKeys = parseApiKeys(env.API_KEYS);
  if (apiKeys.length === 0 && env.NODE_ENV === 'production' && env.ALLOW_UNAUTHENTICATED !== 'true') {
    throw new Error('API_KEYS must be set in production (set ALLOW_UNAUTHENTICATED=true only to run an open API on purpose)');
  }
  return {
    apiKeys,
    apiKeyCacheTtlMs: int(env.API_KEY_CACHE_TTL_MS, 10_000),
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5432/ledger',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    queuePrefix: env.QUEUE_PREFIX ?? 'ledger',
    defaultProvider: env.DEFAULT_PROVIDER ?? 'simulated',
    platformFeeBps: int(env.PLATFORM_FEE_BPS, 1000),
    payoutHoldDays: int(env.PAYOUT_HOLD_DAYS, 2),
    payoutReserveMinor: int(env.PAYOUT_RESERVE_MINOR, 500),
    payoutMinMinor: int(env.PAYOUT_MIN_MINOR, 100),
    payoutMaxAttempts: int(env.PAYOUT_MAX_ATTEMPTS, 3),
    payoutRetryBackoffMs: int(env.PAYOUT_RETRY_BACKOFF_MS, 60_000),
    // Schedulers live in the worker tier: an `api` process never registers the cron jobs.
    schedulersEnabled: env.SCHEDULERS_ENABLED !== 'false' && role !== 'api',
    role,
    workerHealthPort: int(env.WORKER_PORT, 3001),
    simulatedWebhookBaseUrl: env.SIMULATED_WEBHOOK_BASE_URL || undefined,
    logFormat: env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'pretty' ? env.LOG_FORMAT : env.NODE_ENV === 'production' ? 'json' : 'pretty',
    logLevel: (['verbose', 'debug', 'info', 'warn', 'error'] as const).find((l) => l === env.LOG_LEVEL) ?? 'info',
    tracingEnabled: tracingEnabled(env),
    providerOpLeaseMs: int(env.PROVIDER_OP_LEASE_MS, 60_000),
    providerOpMaxAttempts: int(env.PROVIDER_OP_MAX_ATTEMPTS, 10),
    paymentRecoveryAgeMs: int(env.PAYMENT_RECOVERY_AGE_MS, 60_000),
    paymentRecoveryCron: env.PAYMENT_RECOVERY_CRON || '* * * * *',
    authorizationTtlHours: int(env.AUTHORIZATION_TTL_HOURS, 168),
    idempotencyKeyTtlHours: int(env.IDEMPOTENCY_KEY_TTL_HOURS, 168),
    webhookRetentionDays: int(env.WEBHOOK_RETENTION_DAYS, 30),
    reconciliationItemRetentionDays: Math.max(1, int(env.RECONCILIATION_ITEM_RETENTION_DAYS, 180)),
    reconciliationLookbackDays: Math.max(1, int(env.RECONCILIATION_LOOKBACK_DAYS, 3)),
    reconciliationStaleDays: Math.max(1, int(env.RECONCILIATION_STALE_DAYS, 3)),
    maintenanceCron: env.MAINTENANCE_CRON || '0 4 * * *',
    rateLimitMax: int(env.RATE_LIMIT_MAX, 300),
    rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitStore: rateLimitStore(env.RATE_LIMIT_STORE),
    rateLimitStoreTimeoutMs: int(env.RATE_LIMIT_STORE_TIMEOUT_MS, 250),
    bodyLimit: env.BODY_LIMIT || '256kb',
    trustProxy: env.TRUST_PROXY ? int(env.TRUST_PROXY, 0) : undefined,
    payoutStaleMs: int(env.PAYOUT_STALE_MS, 30 * 60_000),
    payoutAwaitingProviderMs: int(env.PAYOUT_AWAITING_PROVIDER_MS, 24 * 3_600_000),
    payoutSweepCron: env.PAYOUT_SWEEP_CRON || '*/10 * * * *',
    webhookToleranceSeconds: int(env.WEBHOOK_TOLERANCE_SECONDS, 300),
    webhookMaxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 5),
    webhookBackoffMs: int(env.WEBHOOK_BACKOFF_MS, 1000),
    simulatedWebhookSecret: env.SIMULATED_WEBHOOK_SECRET ?? 'whsec_simulated_dev',
    simulatedFeeBps: int(env.SIMULATED_FEE_BPS, 0),
    simulatedFeeFixedMinor: int(env.SIMULATED_FEE_FIXED_MINOR, 0),
    providerTimeoutMs: int(env.PROVIDER_TIMEOUT_MS, 15_000),
    healthCheckTimeoutMs: int(env.HEALTH_CHECK_TIMEOUT_MS, 2000),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || undefined,
    alertTimeoutMs: int(env.ALERT_TIMEOUT_MS, 5000),
    alertDlqThreshold: int(env.ALERT_DLQ_THRESHOLD, 1),
    monitorCron: env.MONITOR_CRON || '*/15 * * * *',
    stripeApiBase: env.STRIPE_API_BASE || 'https://api.stripe.com/v1',
    razorpayApiBase: env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1',
    stripeSecretKey: env.STRIPE_SECRET_KEY || undefined,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    razorpayKeyId: env.RAZORPAY_KEY_ID || undefined,
    razorpayKeySecret: env.RAZORPAY_KEY_SECRET || undefined,
    razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || undefined,
  };
}

export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null as null,
  };
}
