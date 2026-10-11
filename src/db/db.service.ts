import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config';

// bigint (int8) and numeric (sums) arrive as strings by default. All money here is
// bounded well below 2^53 (see MAX_AMOUNT_MINOR), so parsing to number is exact.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

export type Queryable = Pick<PoolClient, 'query'>;

const MIGRATION_LOCK_ID = 727_001;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
  }

  async onModuleInit(): Promise<void> {
    await this.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    return this.pool.query<R>(sql, params as unknown[]);
  }

  /** Run `fn` in a single transaction (READ COMMITTED; callers take row locks explicitly). */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const file of files) {
        const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
        if (done.rowCount) continue;
        this.logger.log(`Applying migration ${file}`);
        await client.query('BEGIN');
        try {
          await client.query(readFileSync(join(dir, file), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
      client.release();
    }
  }
}
