import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WEBHOOK_QUEUE } from '../common/queues';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { WebhookEvent } from '../providers/provider.interface';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: DbService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Persist the event (dedupe on provider + event id) and make sure a processing job exists.
   * Returning quickly keeps the provider's delivery fast; the real work happens in the worker.
   */
  async receive(provider: string, event: WebhookEvent): Promise<{ duplicate: boolean }> {
    const inserted = await this.db.query(
      `INSERT INTO webhook_events (provider, event_id, type, payload) VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider, event_id) DO NOTHING`,
      [provider, event.id, event.type, JSON.stringify(event)],
    );
    const duplicate = inserted.rowCount === 0;
    if (duplicate) {
      const existing = await this.db.query<{ status: string }>(
        'SELECT status FROM webhook_events WHERE provider = $1 AND event_id = $2',
        [provider, event.id],
      );
      // Already finished (or dead-lettered): nothing to do. Otherwise fall through and make sure a
      // job exists, in case the first delivery stored the row but failed to enqueue (Redis blip).
      if (existing.rows[0]?.status !== 'received') return { duplicate: true };
    }
    await this.enqueue(provider, event.id);
    return { duplicate };
  }

  /** jobId = provider + event id, so enqueueing the same event twice never creates two jobs. */
  enqueue(provider: string, eventId: string, resetFailed = false) {
    return this.queue.add(
      'process',
      { provider, eventId },
      {
        jobId: `${provider}--${eventId}${resetFailed ? `--retry-${Date.now()}` : ''}`,
        attempts: this.config.webhookMaxAttempts,
        backoff: { type: 'exponential', delay: this.config.webhookBackoffMs },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    );
  }

  async deadLetters() {
    const r = await this.db.query(
      `SELECT provider, event_id AS "eventId", type, attempts, last_error AS "lastError", received_at AS "receivedAt"
         FROM webhook_events WHERE status = 'dead' ORDER BY received_at DESC LIMIT 200`,
    );
    return r.rows;
  }

  /** Manually re-drive a dead-lettered event (e.g. after fixing the bug that killed it). */
  async retryDeadLetter(provider: string, eventId: string) {
    const r = await this.db.query(
      `UPDATE webhook_events SET status = 'received', attempts = 0, last_error = NULL
        WHERE provider = $1 AND event_id = $2 AND status = 'dead'`,
      [provider, eventId],
    );
    if (r.rowCount === 0) throw new NotFoundException('No such dead-lettered event');
    await this.enqueue(provider, eventId, true);
    return { requeued: true };
  }
}
