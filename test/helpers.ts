import { INestApplication, LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DbService } from '../src/db/db.service';
import { WebhookEvent } from '../src/providers/provider.interface';
import { SimulatedProvider } from '../src/providers/simulated.provider';
import { e2eMode } from './e2e-mode';

/** e2e suites need real Postgres + Redis: skipped locally without them, but a hard failure in CI (see e2eMode). */
const mode = e2eMode(process.env);
export const e2eEnabled = mode === 'run';
const failLoudly = ((name: string) =>
  describe(name, () => {
    it('requires DATABASE_URL and REDIS_URL (CI refuses to skip the e2e suites silently)', () => {
      throw new Error('DATABASE_URL and REDIS_URL must be set when CI is true; otherwise no e2e test would run.');
    });
  })) as unknown as typeof describe;
export const describeE2E: typeof describe = mode === 'run' ? describe : mode === 'skip' ? describe.skip : failLoudly;

export interface TestApp {
  app: INestApplication;
  db: DbService;
  sim: SimulatedProvider;
  url: string;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }>;
  /** Wait until all simulated webhooks have been delivered and processed. */
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startApp(env: Record<string, string> = {}, opts: { logger?: LoggerService } = {}): Promise<TestApp> {
  Object.assign(process.env, {
    // Isolated queues per run, no wall-clock schedulers, fast retries.
    QUEUE_PREFIX: `test-${randomUUID().slice(0, 8)}`,
    SCHEDULERS_ENABLED: 'false',
    WEBHOOK_BACKOFF_MS: '50',
    PAYOUT_RETRY_BACKOFF_MS: '50',
    WEBHOOK_MAX_ATTEMPTS: '3',
    PAYOUT_HOLD_DAYS: '2',
    PAYOUT_RESERVE_MINOR: '500',
    PAYOUT_MIN_MINOR: '100',
    PAYOUT_MAX_ATTEMPTS: '2',
    PLATFORM_FEE_BPS: '1000',
    PAYMENT_RECOVERY_AGE_MS: '0', // tests call the recovery sweep directly and expect it to act at once
    PROVIDER_OP_LEASE_MS: '2000',
    RATE_LIMIT_MAX: '100000', // suites hammer the API from one IP; edge-protection tests lower it
    ...env,
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: opts.logger ?? ['error', 'warn'] });
  configureApp(app);
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const sim = app.get(SimulatedProvider);
  sim.setBaseUrl(url);
  const db = app.get(DbService);
  const call: TestApp['call'] = async (method, path, body, headers = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const drain = async () => {
    await sim.flush();
    await waitFor(
      async () => (await db.query("SELECT 1 FROM webhook_events WHERE status = 'received'")).rowCount === 0,
      10000,
      'webhook queue to drain',
    ).catch(() => undefined);
  };
  const close = async () => {
    // Let in-flight webhook deliveries and their queue jobs finish before tearing down the pool.
    await drain();
    await app.close();
  };
  return { app, db, sim, url, call, drain, close };
}

export async function resetDb(db: DbService): Promise<void> {
  await db.query(`TRUNCATE accounts, journal_entries, postings, account_balances, payments, refunds, idempotency_keys,
    webhook_events, payouts, reconciliation_reports, sim_provider_transactions, api_keys RESTART IDENTITY CASCADE`);
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let n = 0;
export const key = () => `k-${Date.now()}-${n++}-${randomUUID().slice(0, 6)}`;

export const newPayment = (over: Record<string, unknown> = {}) => ({
  buyerId: 'buyer_1',
  sellerId: 'acme_bikes',
  amount: 10000,
  currency: 'USD',
  ...over,
});

export const evt = (type: string, data: WebhookEvent['data'], id = `evt_${randomUUID()}`): WebhookEvent => ({
  id,
  type,
  createdAt: Math.floor(Date.now() / 1000),
  data,
});
