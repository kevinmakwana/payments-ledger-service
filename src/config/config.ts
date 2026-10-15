export interface AppConfig {
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
  webhookToleranceSeconds: number;
  webhookMaxAttempts: number;
  webhookBackoffMs: number;
  simulatedWebhookSecret: string;
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

const int = (v: string | undefined, d: number): number => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Expected integer env value, got "${v}"`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
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
    schedulersEnabled: env.SCHEDULERS_ENABLED !== 'false',
    webhookToleranceSeconds: int(env.WEBHOOK_TOLERANCE_SECONDS, 300),
    webhookMaxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 5),
    webhookBackoffMs: int(env.WEBHOOK_BACKOFF_MS, 1000),
    simulatedWebhookSecret: env.SIMULATED_WEBHOOK_SECRET ?? 'whsec_simulated_dev',
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
