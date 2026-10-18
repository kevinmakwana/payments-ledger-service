export type E2eMode = 'run' | 'skip' | 'fail';

/**
 * What the e2e suites should do given the environment:
 *  - run:  Postgres and Redis URLs are provided.
 *  - skip: they are not (a quick local `npm run test:e2e` without Docker).
 *  - fail: they are not, but this is CI. Silently skipping there would let a broken pipeline report green with nothing tested.
 */
export function e2eMode(env: Record<string, string | undefined>): E2eMode {
  if (env.DATABASE_URL && env.REDIS_URL) return 'run';
  const ci = env.CI && env.CI !== 'false' && env.CI !== '0';
  return ci ? 'fail' : 'skip';
}
