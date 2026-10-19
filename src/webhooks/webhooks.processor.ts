import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { AlertService } from '../alerts/alert.service';
import { WEBHOOK_DLQ, WEBHOOK_QUEUE } from '../common/queues';
import { DbService } from '../db/db.service';
import { WebhookEvent } from '../providers/provider.interface';
import { WebhookHandlers } from './webhook-handlers';

interface WebhookJob {
  provider: string;
  eventId: string;
}

@Processor(WEBHOOK_QUEUE, { concurrency: 5, autorun: false })
export class WebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhooksProcessor.name);

  constructor(
    private readonly db: DbService,
    private readonly handlers: WebhookHandlers,
    private readonly alerts: AlertService,
    @InjectQueue(WEBHOOK_DLQ) private readonly dlq: Queue,
  ) {
    super();
  }

  async process(job: Job<WebhookJob>): Promise<void> {
    const { provider, eventId } = job.data;
    const row = await this.db.query<{ payload: WebhookEvent; status: string }>(
      'SELECT payload, status FROM webhook_events WHERE provider = $1 AND event_id = $2',
      [provider, eventId],
    );
    const event = row.rows[0];
    if (!event || event.status === 'processed') return; // handlers are idempotent; skip finished work
    await this.db.query('UPDATE webhook_events SET attempts = attempts + 1 WHERE provider = $1 AND event_id = $2', [provider, eventId]);
    await this.handlers.handle(provider, event.payload);
    await this.db.query(
      `UPDATE webhook_events SET status = 'processed', processed_at = now(), last_error = NULL WHERE provider = $1 AND event_id = $2`,
      [provider, eventId],
    );
  }

  /** Runs after every failed attempt; once retries are exhausted the event is dead-lettered. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<WebhookJob> | undefined, err: Error): Promise<void> {
    if (!job) return;
    try {
      await this.recordFailure(job, err);
    } catch (e) {
      // Never let bookkeeping errors escape an event listener (e.g. DB closed during shutdown).
      this.logger.error(`Could not record webhook failure for ${job.data.provider}/${job.data.eventId}: ${e}`);
    }
  }

  private async recordFailure(job: Job<WebhookJob>, err: Error): Promise<void> {
    const { provider, eventId } = job.data;
    await this.db.query('UPDATE webhook_events SET last_error = $3 WHERE provider = $1 AND event_id = $2', [provider, eventId, err.message]);
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(`Webhook ${provider}/${eventId} attempt ${job.attemptsMade}/${maxAttempts} failed: ${err.message}`);
      return;
    }
    this.logger.error(`Webhook ${provider}/${eventId} exhausted ${maxAttempts} attempts; moving to dead-letter queue`);
    await this.db.query(`UPDATE webhook_events SET status = 'dead' WHERE provider = $1 AND event_id = $2`, [provider, eventId]);
    await this.dlq.add('dead', { ...job.data, error: err.message, attempts: job.attemptsMade }, { removeOnComplete: false });
    await this.alerts.raise({
      kind: 'webhook_dead_lettered',
      severity: 'warning',
      message: `Webhook ${provider}/${eventId} was dead-lettered after ${job.attemptsMade} attempts: ${err.message}`,
      details: { provider, eventId, attempts: job.attemptsMade, error: err.message },
    });
  }
}
