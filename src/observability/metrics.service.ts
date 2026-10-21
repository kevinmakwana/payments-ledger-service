import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  MAINTENANCE_QUEUE,
  MONITOR_QUEUE,
  PAYMENT_RECOVERY_QUEUE,
  PAYOUT_QUEUE,
  RECONCILIATION_QUEUE,
  WEBHOOK_DLQ,
  WEBHOOK_QUEUE,
} from '../common/queues';
import { DbService } from '../db/db.service';

/**
 * Prometheus metrics. Counters/histograms are updated inline; gauges that describe "how much work is waiting"
 * are computed at scrape time from Postgres and Redis (cheap, indexed queries), so they can never go stale.
 * A registry per instance keeps tests (and multiple apps in one process) isolated.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route pattern and status',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly providerCalls = new Counter({
    name: 'provider_calls_total',
    help: 'Calls to payment providers by outcome (success, rejected = definitive refusal, error = outcome unknown)',
    labelNames: ['provider', 'operation', 'outcome'],
    registers: [this.registry],
  });
  readonly providerDuration = new Histogram({
    name: 'provider_call_duration_seconds',
    help: 'Payment provider call duration in seconds',
    labelNames: ['provider', 'operation'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
    registers: [this.registry],
  });
  readonly alertsRaised = new Counter({
    name: 'alerts_total',
    help: 'Operational alerts raised',
    labelNames: ['kind', 'severity'],
    registers: [this.registry],
  });
  readonly rateLimitFallbacks = new Counter({
    name: 'rate_limit_store_fallbacks_total',
    help: 'Requests counted in memory because the Redis rate-limit store was unavailable (limits are per instance meanwhile)',
    registers: [this.registry],
  });
  /** 1 when cached balances agree with postings and every currency sums to zero, as of the last monitor run. */
  readonly ledgerConsistent = new Gauge({
    name: 'ledger_consistent',
    help: '1 if the last monitor run found the ledger consistent, 0 if not',
    registers: [this.registry],
  });

  constructor(
    private readonly db: DbService,
    @InjectQueue(WEBHOOK_QUEUE) webhooks: Queue,
    @InjectQueue(WEBHOOK_DLQ) webhooksDlq: Queue,
    @InjectQueue(PAYOUT_QUEUE) payouts: Queue,
    @InjectQueue(RECONCILIATION_QUEUE) reconciliation: Queue,
    @InjectQueue(MONITOR_QUEUE) monitor: Queue,
    @InjectQueue(MAINTENANCE_QUEUE) maintenance: Queue,
    @InjectQueue(PAYMENT_RECOVERY_QUEUE) paymentRecovery: Queue,
  ) {
    collectDefaultMetrics({ register: this.registry });
    const queues = [webhooks, webhooksDlq, payouts, reconciliation, monitor, maintenance, paymentRecovery];
    const states = ['waiting', 'active', 'delayed', 'failed'] as const;
    new Gauge({
      name: 'queue_jobs',
      help: 'Jobs per queue and state',
      labelNames: ['queue', 'state'],
      registers: [this.registry],
      async collect() {
        for (const q of queues) {
          const counts = await q.getJobCounts(...states);
          for (const state of states) this.set({ queue: q.name, state }, counts[state] ?? 0);
        }
      },
    });

    const db_ = this.db;
    new Gauge({
      name: 'webhook_events_dead',
      help: 'Webhook events that exhausted their retries and wait for a manual retry',
      registers: [this.registry],
      async collect() {
        this.set((await db_.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'dead'")).rows[0].n);
      },
    });
    new Gauge({
      name: 'payments_in_flight',
      help: 'Payments waiting on a provider call, by state',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        const r = await db_.query<{ status: string; n: number }>(
          "SELECT status, count(*)::int AS n FROM payments WHERE status IN ('created','capturing','voiding') GROUP BY status",
        );
        const by = new Map(r.rows.map((row) => [row.status, row.n]));
        for (const status of ['created', 'capturing', 'voiding']) this.set({ status }, by.get(status) ?? 0);
      },
    });
    new Gauge({
      name: 'provider_operations_open',
      help: 'Outbox operations not yet settled, by status',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        const r = await db_.query<{ status: string; n: number }>(
          "SELECT status, count(*)::int AS n FROM provider_operations WHERE status IN ('pending','in_flight') GROUP BY status",
        );
        const by = new Map(r.rows.map((row) => [row.status, row.n]));
        for (const status of ['pending', 'in_flight']) this.set({ status }, by.get(status) ?? 0);
      },
    });
    new Gauge({
      name: 'reconciliation_items',
      help: 'Tracked reconciliation discrepancies by status (open ones need attention)',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        const r = await db_.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM reconciliation_items GROUP BY status');
        const by = new Map(r.rows.map((row) => [row.status, row.n]));
        for (const status of ['open', 'ignored', 'resolved']) this.set({ status }, by.get(status) ?? 0);
      },
    });
    new Gauge({
      name: 'reconciliation_oldest_open_item_age_seconds',
      help: 'Age of the oldest open reconciliation discrepancy (0 when there is none)',
      registers: [this.registry],
      async collect() {
        const r = await db_.query<{ age: number }>("SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(first_seen_at)), 0)::float8 AS age FROM reconciliation_items WHERE status = 'open'");
        this.set(Math.round(r.rows[0].age));
      },
    });
    new Gauge({
      name: 'payouts_pending',
      help: 'Payouts created but not yet paid or failed',
      registers: [this.registry],
      async collect() {
        this.set((await db_.query<{ n: number }>("SELECT count(*)::int AS n FROM payouts WHERE status = 'pending'")).rows[0].n);
      },
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
