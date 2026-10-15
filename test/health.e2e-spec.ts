import { describeE2E, startApp, TestApp } from './helpers';

describeE2E('health endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('liveness answers ok without touching dependencies', async () => {
    const res = await t.call('GET', '/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it.each(['/health/ready', '/health'])('%s reports Postgres and Redis up', async (path) => {
    const res = await t.call('GET', path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('readiness returns 503 naming the failing dependency when Postgres is unreachable', async () => {
    const spy = jest.spyOn(t.db, 'query').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:5432'));
    try {
      const res = await t.call('GET', '/health/ready');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'unavailable', checks: { database: 'down', redis: 'up' } });
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.9');
      const live = await t.call('GET', '/health/live');
      expect(live.status).toBe(200); // a dependency outage must not fail liveness
    } finally {
      spy.mockRestore();
    }
  });
});
