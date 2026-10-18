import { SetMetadata } from '@nestjs/common';

export type Access = 'public' | 'admin';
export const ACCESS_KEY = 'access';

/** No API key needed (health checks, webhook intake which is authenticated by signature). */
export const Public = () => SetMetadata(ACCESS_KEY, 'public' satisfies Access);
/** Requires an `admin` key. Without a decorator a route requires any valid key (`client` or `admin`). */
export const AdminOnly = () => SetMetadata(ACCESS_KEY, 'admin' satisfies Access);
