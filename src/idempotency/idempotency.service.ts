import { Injectable } from '@nestjs/common';
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
}
