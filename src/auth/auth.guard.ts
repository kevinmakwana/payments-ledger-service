import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { authenticate, extractToken, roleSatisfies } from './api-keys';
import { Access, ACCESS_KEY } from './auth.decorators';

/**
 * Global guard. Default is secure: every route needs a valid API key unless marked `@Public()`;
 * `@AdminOnly()` additionally needs the admin role. Method-level metadata overrides controller-level.
 */
@Injectable()
export class AuthGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.apiKeys.length === 0) {
      this.logger.warn('API authentication is DISABLED (API_KEYS is not set). Do not expose this instance to untrusted networks.');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.config.apiKeys.length === 0) return true;
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [context.getHandler(), context.getClass()]);
    if (access === 'public') return true;

    const req = context.switchToHttp().getRequest<Request>();
    const role = authenticate(this.config.apiKeys, extractToken(req.headers));
    if (!role) throw new UnauthorizedException({ code: 'unauthorized', message: 'A valid API key is required (Authorization: Bearer <key> or X-API-Key)' });
    if (!roleSatisfies(role, access === 'admin' ? 'admin' : 'client')) {
      throw new ForbiddenException({ code: 'forbidden', message: 'This endpoint requires an admin API key' });
    }
    return true;
  }
}
