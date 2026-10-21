import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from './api-keys';

export type Access = 'public' | 'admin';
export const ACCESS_KEY = 'access';

/** No API key needed (health checks, webhook intake which is authenticated by signature). */
export const Public = () => SetMetadata(ACCESS_KEY, 'public' satisfies Access);
/** Requires an `admin` key. Without a decorator a route requires any valid key (`client` or `admin`). */
export const AdminOnly = () => SetMetadata(ACCESS_KEY, 'admin' satisfies Access);

/** The authenticated caller, or undefined when authentication is disabled or the route is public. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal | undefined => {
  return (ctx.switchToHttp().getRequest<Request & { principal?: Principal }>()).principal;
});
