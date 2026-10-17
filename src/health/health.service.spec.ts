import { runHealthChecks } from './health.service';

const never = () => new Promise<never>(() => undefined);

describe('runHealthChecks', () => {
  it('is ok when every probe resolves', async () => {
    const out = await runHealthChecks({ database: async () => 1, redis: async () => 'PONG' }, 200);
    expect(out).toEqual({ ok: true, checks: { database: 'up', redis: 'up' } });
  });

  it('marks only the failing dependency down and reports the failure to the callback', async () => {
    const failures: string[] = [];
    const out = await runHealthChecks(
      { database: async () => 1, redis: async () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:6379')) },
      200,
      (name, err) => failures.push(`${name}: ${(err as Error).message}`),
    );
    expect(out).toEqual({ ok: false, checks: { database: 'up', redis: 'down' } });
    expect(failures).toEqual(['redis: ECONNREFUSED 10.0.0.5:6379']);
    expect(JSON.stringify(out)).not.toContain('10.0.0.5'); // internal addresses never reach the response
  });

  it('treats a probe that hangs as down once the timeout passes', async () => {
    const started = Date.now();
    const out = await runHealthChecks({ database: never, redis: async () => 'PONG' }, 50);
    expect(out).toEqual({ ok: false, checks: { database: 'down', redis: 'up' } });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('runs probes concurrently, not one after another', async () => {
    const slow = () => new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await runHealthChecks({ a: slow, b: slow, c: slow }, 1000);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
