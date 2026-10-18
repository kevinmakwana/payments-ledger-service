import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuthGuard } from './auth.guard';

/**
 * Edge protection. Global guards run in registration order, so the rate limit comes FIRST: it is keyed
 * by client IP, which means an attacker guessing API keys is throttled before the key check even runs
 * (and cannot get a fresh budget by presenting a different key).
 * Counters are in memory, i.e. per instance; a shared Redis store is the upgrade path for exact global limits.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [{ ttl: config.rateLimitWindowMs, limit: config.rateLimitMax }],
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
