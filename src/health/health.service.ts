import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig, redisConnection } from '../config/config';
import { DbService } from '../db/db.service';

export type Probe = () => Promise<unknown>;
export type CheckStatus = 'up' | 'down';
export interface HealthResult {
  ok: boolean;
  checks: Record<string, CheckStatus>;
}

/**
 * Run all probes concurrently, each with a deadline. A dependency that errors or hangs is
 * reported `down`; the reason goes to `onFailure` (logs), never into the result, so the public
 * response cannot leak internal hostnames or driver messages.
 */
export async function runHealthChecks(
  probes: Record<string, Probe>,
  timeoutMs: number,
  onFailure?: (name: string, err: unknown) => void,
): Promise<HealthResult> {
  const entries = await Promise.all(
    Object.entries(probes).map(async ([name, probe]): Promise<[string, CheckStatus]> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        await Promise.race([probe(), deadline]);
        return [name, 'up'];
      } catch (err) {
        onFailure?.(name, err);
        return [name, 'down'];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const checks = Object.fromEntries(entries);
  return { ok: entries.every(([, status]) => status === 'up'), checks };
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redis: Redis;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // A dedicated fail-fast connection: BullMQ's own connections are configured to wait forever
    // (maxRetriesPerRequest: null), which is the opposite of what a health probe wants.
    this.redis = new Redis({ ...redisConnection(config.redisUrl), maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on('error', () => undefined); // surfaced through the probe result instead
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  readiness(): Promise<HealthResult> {
    return runHealthChecks(
      {
        database: () => this.db.query('SELECT 1'),
        redis: () => this.redis.ping(),
      },
      this.config.healthCheckTimeoutMs,
      (name, err) => this.logger.error(`Readiness: ${name} is down: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}
