import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import Redis from 'ioredis';
import { redisConnection } from '../config/config';

/**
 * One atomic step per request, so concurrent instances never lose or double-count a hit.
 * Fixed window: the first hit creates the counter with the window's TTL; later hits only increment it.
 * KEYS[1] hit counter, KEYS[2] block marker; ARGV: window ms, limit, block ms.
 * Returns {hits, windowMsLeft, blocked, blockMsLeft}.
 */
const HIT_SCRIPT = `
local blockKey = KEYS[2]
local blockLeft = redis.call('PTTL', blockKey)
if blockLeft > 0 then
  return {tonumber(redis.call('GET', KEYS[1]) or '0'), math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockLeft}
end
local hits = redis.call('INCR', KEYS[1])
local windowLeft = redis.call('PTTL', KEYS[1])
if hits == 1 or windowLeft < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  windowLeft = tonumber(ARGV[1])
end
local blocked = 0
blockLeft = 0
if hits > tonumber(ARGV[2]) then
  blocked = 1
  if tonumber(ARGV[3]) > 0 then
    redis.call('SET', blockKey, '1', 'PX', ARGV[3])
    blockLeft = tonumber(ARGV[3])
  else
    blockLeft = windowLeft
  end
end
return {hits, windowLeft, blocked, blockLeft}
`;

// The record type is not exported from the package root.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;
type HitCommand = (key: string, blockKey: string, windowMs: number, limit: number, blockMs: number) => Promise<[number, number, number, number]>;
type RedisWithHit = Redis & { rateLimitHit: HitCommand };

/**
 * Rate-limit counters in Redis, shared by every API instance, so `RATE_LIMIT_MAX` is a real global limit instead of
 * a per-instance one. Availability beats exactness here: if Redis is slow or down, requests are counted in memory
 * (per instance, the previous behaviour) rather than rejected, and `onFallback` is told so it can be alerted on.
 */
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger('RateLimit');
  private readonly fallback = new ThrottlerStorageService();
  private lastWarnAt = 0;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly onFallback: () => void = () => undefined,
  ) {
    redis.defineCommand('rateLimitHit', { numberOfKeys: 2, lua: HIT_SCRIPT });
    redis.on('error', () => undefined); // reported through the fallback path instead
  }

  /**
   * Resolves once the connection is ready (or after `timeoutMs`, so a Redis outage never blocks startup). Without
   * this the very first requests would find the connection still opening and be counted in memory instead.
   */
  async connected(timeoutMs = 2000): Promise<this> {
    if (this.redis.status === 'ready') return this;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this;
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    try {
      // The hash tag keeps both keys in one slot, so the script also works against a Redis Cluster.
      const base = `${this.prefix}:{${throttlerName}:${key}}`;
      const [hits, windowMs, blocked, blockMs] = await (this.redis as RedisWithHit).rateLimitHit(base, `${base}:block`, ttl, limit, Math.max(blockDuration, 0));
      return { totalHits: hits, timeToExpire: Math.ceil(windowMs / 1000), isBlocked: blocked === 1, timeToBlockExpire: Math.ceil(blockMs / 1000) };
    } catch (err) {
      this.onFallback();
      const now = Date.now();
      if (now - this.lastWarnAt > 30_000) {
        this.lastWarnAt = now;
        this.logger.warn(`Redis rate-limit store unavailable (${err instanceof Error ? err.message : String(err)}); counting in memory, per instance`);
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  onModuleDestroy(): void {
    // disconnect() on a connection that has already ended would arm a pointless 2 s timer that delays process exit.
    if (this.redis.status !== 'end') this.redis.disconnect();
    this.fallback.onApplicationShutdown?.();
  }
}

/** A fail-fast connection of its own: the queues' connections wait forever, which would stall every request. */
export function rateLimitRedis(connection: ReturnType<typeof redisConnection>, commandTimeoutMs: number): Redis {
  return new Redis({ ...connection, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: commandTimeoutMs });
}
