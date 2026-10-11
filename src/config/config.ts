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
  webhookToleranceSeconds: number;
  webhookMaxAttempts: number;
  webhookBackoffMs: number;
  simulatedWebhookSecret: string;
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
    webhookToleranceSeconds: int(env.WEBHOOK_TOLERANCE_SECONDS, 300),
    webhookMaxAttempts: int(env.WEBHOOK_MAX_ATTEMPTS, 5),
    webhookBackoffMs: int(env.WEBHOOK_BACKOFF_MS, 1000),
    simulatedWebhookSecret: env.SIMULATED_WEBHOOK_SECRET ?? 'whsec_simulated_dev',
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
