import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PoolClient } from 'pg';
import { IdempotencyConflictError } from '../common/errors';
import { stableStringify } from '../common/money';
import { DbService } from '../db/db.service';

export interface StoredResponse<T = unknown> {
  status: number;
  body: T;
}

export const hashRequest = (body: unknown): string =>
  createHash('sha256').update(stableStringify(body ?? null)).digest('hex');

@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DbService) {}

  /**
   * Run `fn` at most once per (scope, key).
   *
   * The key row is inserted in the SAME transaction as the work. A concurrent request with
   * the same key blocks on that insert until the first transaction commits (then replays its
   * stored response) or rolls back (then it runs the work itself). So a retry can never
   * observe "key reserved but work not done", and failed attempts leave no trace.
   *
   * Same key + different request body => 409.
   */
  async run<T>(
    scope: string,
    key: string,
    requestBody: unknown,
    fn: (client: PoolClient) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T> & { replayed: boolean }> {
    const hash = hashRequest(requestBody);
    return this.db.tx(async (client) => {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1,$2,$3)
         ON CONFLICT (scope, key) DO NOTHING`,
        [scope, key, hash],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{ request_hash: string; response_status: number; response_body: T }>(
          'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
          [scope, key],
        );
        const row = existing.rows[0];
        if (row.request_hash !== hash) throw new IdempotencyConflictError();
        return { status: row.response_status, body: row.response_body, replayed: true };
      }
      const response = await fn(client);
      await client.query('UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2', [
        scope,
        key,
        response.status,
        JSON.stringify(response.body),
      ]);
      return { ...response, replayed: false };
    });
  }

  /**
   * Like `run`, but for work whose slow part (provider calls) must NOT hold a DB transaction open.
   *
   *  1. `start` runs in a short transaction together with the key insert: it validates and records the intent
   *     (payment row, outbox operation, ...) and returns the id of the resource to drive. Throwing here rolls
   *     everything back, including the key, so failed validations stay retryable.
   *  2. After that commit, `finish(resourceId)` does the slow, retryable work and returns the response. It must
   *     be safe to call repeatedly and concurrently (it is driven by the outbox, whose provider calls are idempotent).
   *  3. The response is stored first-writer-wins, and every caller returns the stored one, so concurrent
   *     duplicates get identical bodies.
   *
   * If the process dies between 1 and 3, the key row already points at the resource, so a retry with the same key
   * resumes via `finish` instead of starting over. A `finish` that throws (e.g. provider timeout) stores nothing.
   */
  async runDurable<T>(
    scope: string,
    key: string,
    requestBody: unknown,
    hooks: {
      start: (client: PoolClient) => Promise<string>;
      finish: (resourceId: string) => Promise<StoredResponse<T>>;
    },
  ): Promise<StoredResponse<T> & { replayed: boolean }> {
    const hash = hashRequest(requestBody);
    type Phase = { kind: 'fresh' | 'resume'; resourceId: string } | { kind: 'replay'; status: number; body: T };
    const phase = await this.db.tx<Phase>(async (client) => {
      const inserted = await client.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT (scope, key) DO NOTHING`,
        [scope, key, hash],
      );
      if (inserted.rowCount === 0) {
        const r = await client.query<{ request_hash: string; response_status: number | null; response_body: T; resource_id: string | null }>(
          'SELECT request_hash, response_status, response_body, resource_id FROM idempotency_keys WHERE scope = $1 AND key = $2',
          [scope, key],
        );
        const row = r.rows[0];
        if (row.request_hash !== hash) throw new IdempotencyConflictError();
        if (row.response_status !== null) return { kind: 'replay', status: row.response_status, body: row.response_body };
        if (row.resource_id) return { kind: 'resume', resourceId: row.resource_id };
        throw new ConflictException({ code: 'request_in_progress', message: 'A request with this Idempotency-Key is still being recorded; retry shortly' });
      }
      const resourceId = await hooks.start(client);
      await client.query('UPDATE idempotency_keys SET resource_id = $3 WHERE scope = $1 AND key = $2', [scope, key, resourceId]);
      return { kind: 'fresh', resourceId };
    });
    if (phase.kind === 'replay') return { status: phase.status, body: phase.body, replayed: true };

    const response = await hooks.finish(phase.resourceId);
    const stored = await this.db.query(
      'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2 AND response_status IS NULL',
      [scope, key, response.status, JSON.stringify(response.body)],
    );
    if (stored.rowCount === 1) return { ...response, replayed: phase.kind === 'resume' };
    // Someone else stored first (a concurrent duplicate): return theirs so all callers see the same response.
    const winner = await this.db.query<{ response_status: number; response_body: T }>(
      'SELECT response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
      [scope, key],
    );
    return { status: winner.rows[0].response_status, body: winner.rows[0].response_body, replayed: true };
  }
}
