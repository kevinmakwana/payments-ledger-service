import { Module } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig, redisConnection } from '../config/config';
import { MetricsService } from '../observability/metrics.service';
import { RedisThrottlerStorage, rateLimitRedis } from './redis-throttler.storage';

export const RATE_LIMIT_STORAGE = Symbol('RATE_LIMIT_STORAGE');

/** Owns the rate-limit counter store (a provider, so its connection is closed on shutdown). */
@Module({
  providers: [
    {
      provide: RATE_LIMIT_STORAGE,
      inject: [APP_CONFIG, MetricsService],
      useFactory: (config: AppConfig, metrics: MetricsService) =>
        config.rateLimitStore === 'redis'
          ? new RedisThrottlerStorage(rateLimitRedis(redisConnection(config.redisUrl), config.rateLimitStoreTimeoutMs), `${config.queuePrefix}:ratelimit`, () => metrics.rateLimitFallbacks.inc()).connected()
          : new ThrottlerStorageService(),
    },
  ],
  exports: [RATE_LIMIT_STORAGE],
})
export class RateLimitModule {}
