import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuthGuard } from './auth.guard';
import { RATE_LIMIT_STORAGE, RateLimitModule } from './rate-limit.module';

/**
 * Edge protection. Global guards run in registration order, so the rate limit comes FIRST: it is keyed
 * by client IP, which means an attacker guessing API keys is throttled before the key check even runs
 * (and cannot get a fresh budget by presenting a different key).
 * Counters live in Redis when RATE_LIMIT_STORE=redis (one global limit across all API instances) and in memory,
 * per instance, otherwise.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RateLimitModule],
      inject: [APP_CONFIG, RATE_LIMIT_STORAGE],
      useFactory: (config: AppConfig, storage: ThrottlerStorage) => ({
        throttlers: [{ ttl: config.rateLimitWindowMs, limit: config.rateLimitMax }],
        storage,
      }),
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
