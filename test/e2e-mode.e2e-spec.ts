import { e2eMode } from './e2e-mode';

// Pure logic, so it runs under the e2e config without needing Postgres or Redis.
describe('e2eMode', () => {
  const infra = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x' };

  it('runs the suites when both service URLs are set, in CI or not', () => {
    expect(e2eMode(infra)).toBe('run');
    expect(e2eMode({ ...infra, CI: 'true' })).toBe('run');
  });

  it('skips locally when the services are not configured', () => {
    expect(e2eMode({})).toBe('skip');
    expect(e2eMode({ DATABASE_URL: 'postgres://x' })).toBe('skip');
    expect(e2eMode({ REDIS_URL: 'redis://x' })).toBe('skip');
  });

  it('FAILS in CI when the services are missing, so a misconfigured pipeline cannot go green with nothing tested', () => {
    expect(e2eMode({ CI: 'true' })).toBe('fail');
    expect(e2eMode({ CI: '1', DATABASE_URL: 'postgres://x' })).toBe('fail');
  });

  it.each(['', 'false', '0'])('treats CI=%j as "not CI"', (ci) => {
    expect(e2eMode({ CI: ci })).toBe('skip');
  });
});
