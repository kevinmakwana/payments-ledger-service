import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { RedisThrottlerStorage, rateLimitRedis } from '../src/auth/redis-throttler.storage';
import { redisConnection } from '../src/config/config';
import { RATE_LIMIT_STORAGE } from '../src/auth/rate-limit.module';
import { MetricsService } from '../src/observability/metrics.service';
import { describeE2E, startApp, TestApp } from './helpers';

const url = () => process.env.REDIS_URL!;

describeE2E('Redis rate-limit store (e2e)', () => {
  describe('counting semantics', () => {
    let redis: Redis;
    let storage: RedisThrottlerStorage;
    let fallbacks = 0;
    const prefix = `rl-test-${randomUUID().slice(0, 8)}`;
    beforeAll(async () => {
      redis = rateLimitRedis(redisConnection(url()), 500);
      storage = await new RedisThrottlerStorage(redis, prefix, () => fallbacks++).connected();
    });
    afterAll(async () => {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      storage.onModuleDestroy();
      expect(fallbacks).toBe(0); // every assertion above ran against Redis, never the in-memory fallback
    });

    const hit = (k: string, ttl = 60_000, limit = 3, block = 0) => storage.increment(k, ttl, limit, block, 'default');

    it('counts hits within the window and flags the ones over the limit, reporting time left in whole seconds', async () => {
      const k = randomUUID();
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await hit(k));
      expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4, 5]);
      expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true, true]);
      expect(results[0].timeToExpire).toBeGreaterThan(55);
      expect(results[4].timeToBlockExpire).toBeGreaterThan(55); // no block duration: blocked until the window ends
      expect(fallbacks).toBe(0);
    });

    it('keeps keys independent of each other', async () => {
      const [a, b] = [randomUUID(), randomUUID()];
      for (let i = 0; i < 4; i++) await hit(a);
      expect((await hit(b)).totalHits).toBe(1);
    });

    it('starts a fresh window once the old one expires', async () => {
      const k = randomUUID();
      for (let i = 0; i < 4; i++) await hit(k, 300);
      expect((await hit(k, 300)).isBlocked).toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      expect(await hit(k, 300)).toMatchObject({ totalHits: 1, isBlocked: false });
    });

    it('does not extend the window for a client that keeps hammering it', async () => {
      const k = randomUUID();
      for (let i = 0; i < 4; i++) await hit(k, 400);
      await new Promise((r) => setTimeout(r, 250));
      for (let i = 0; i < 10; i++) await hit(k, 400); // still inside the original window
      await new Promise((r) => setTimeout(r, 250)); // 500ms after the FIRST hit
      expect((await hit(k, 400)).totalHits).toBe(1);
    });

    it('holds a block for blockDuration even after the window ends', async () => {
      const k = randomUUID();
      for (let i = 0; i < 4; i++) await hit(k, 200, 3, 1500);
      await new Promise((r) => setTimeout(r, 300)); // window gone, block (1.5s) still on
      expect(await hit(k, 200, 3, 1500)).toMatchObject({ isBlocked: true });
    });

    it('is exact under concurrency: parallel hits never lose or double count', async () => {
      const k = randomUUID();
      const results = await Promise.all(Array.from({ length: 60 }, () => hit(k, 60_000, 25)));
      expect(results.map((r) => r.totalHits).sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      expect(results.filter((r) => !r.isBlocked)).toHaveLength(25);
    });
  });

  describe('across API instances', () => {
    let a: TestApp;
    let b: TestApp;
    const shared = { RATE_LIMIT_STORE: 'redis', RATE_LIMIT_MAX: '6', RATE_LIMIT_WINDOW_MS: '60000', QUEUE_PREFIX: `rl-${randomUUID().slice(0, 8)}` };
    beforeAll(async () => {
      a = await startApp(shared);
      b = await startApp(shared);
    });
    afterAll(async () => {
      await a.close();
      await b.close();
      for (const k of Object.keys(shared)) delete process.env[k];
    });
    const ping = (t: TestApp) => t.call('GET', '/payments/00000000-0000-4000-8000-000000000000');

    it('enforces ONE limit across instances: 3 requests to each uses up a budget of 6', async () => {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await ping(a)).status, (await ping(b)).status);
      expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
      const limited = await ping(a);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      expect((await ping(b)).status).toBe(429); // the other instance sees the same exhausted budget
    });

    it('still never throttles health checks', async () => {
      expect((await a.call('GET', '/health/live')).status).toBe(200);
      expect((await b.call('GET', '/health/live')).status).toBe(200);
    });
  });

  describe('when Redis is unavailable', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await startApp({ RATE_LIMIT_STORE: 'redis', RATE_LIMIT_MAX: '4', RATE_LIMIT_WINDOW_MS: '60000' });
    });
    afterAll(async () => {
      await t.close();
      for (const k of ['RATE_LIMIT_STORE', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS']) delete process.env[k];
    });

    it('fails open to per-instance counting: no 500s, the limit still holds, and the fallback is counted', async () => {
      const storage = t.app.get<RedisThrottlerStorage>(RATE_LIMIT_STORAGE);
      (storage as unknown as { redis: Redis }).redis.disconnect(); // connection lost mid-flight
      const ping = () => t.call('GET', '/payments/00000000-0000-4000-8000-000000000000');
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await ping()).status);
      expect(statuses).toEqual([404, 404, 404, 404, 429]);
      const metrics = await t.app.get(MetricsService).registry.getSingleMetricAsString('rate_limit_store_fallbacks_total');
      expect(Number(/rate_limit_store_fallbacks_total (\d+)/.exec(metrics)?.[1])).toBeGreaterThanOrEqual(5);
    });
  });
});
