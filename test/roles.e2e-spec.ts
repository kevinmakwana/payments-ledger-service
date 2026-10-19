import { getQueueToken } from '@nestjs/bullmq';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { loadConfig } from '../src/config/config';
import { signTimestamped } from '../src/providers/signature';
import { startWorkerServer } from '../src/worker-server';
import { describeE2E, evt, resetDb, startApp, TestApp, waitFor } from './helpers';

const ADMIN = 'sk_admin_0123456789abcdef';

describeE2E('process roles: api and worker tiers (e2e, real Postgres + Redis)', () => {
  const prefix = `roles-${randomUUID().slice(0, 8)}`;
  let api: TestApp;
  let worker: INestApplicationContext | undefined;
  let server: Server | undefined;

  beforeAll(async () => {
    // SCHEDULERS_ENABLED=true so the only thing that can stop schedulers registering is the api role itself.
    api = await startApp({ APP_ROLE: 'api', QUEUE_PREFIX: prefix, SCHEDULERS_ENABLED: 'true', API_KEYS: `${ADMIN}:admin` });
    await resetDb(api.db);
  });
  afterAll(async () => {
    server?.close();
    await worker?.close();
    await api.close();
    for (const k of ['APP_ROLE', 'QUEUE_PREFIX', 'SCHEDULERS_ENABLED', 'API_KEYS']) delete process.env[k];
  });

  const status = async (eventId: string) => (await api.db.query('SELECT status FROM webhook_events WHERE event_id = $1', [eventId])).rows[0]?.status as string;
  const schedulers = async (queueName: string) => (await api.app.get<Queue>(getQueueToken(queueName)).getJobSchedulers()).map((s) => s.key);

  it('an api process accepts and queues webhook work, but runs no workers and registers no schedulers', async () => {
    const event = evt('customer.updated', {});
    const body = JSON.stringify(event);
    const res = await fetch(`${api.url}/webhooks/simulated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': signTimestamped('whsec_simulated_dev', body, Math.floor(Date.now() / 1000)) },
      body,
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 1500)); // plenty of time for a worker, were there one
    expect(await status(event.id)).toBe('received');
    expect(await schedulers('payouts')).toEqual([]);
    expect(await schedulers('monitor')).toEqual([]);
  });

  it('a worker process picks that work up, and registers the schedulers', async () => {
    process.env.APP_ROLE = 'worker';
    worker = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    const pending = (await api.db.query("SELECT event_id FROM webhook_events WHERE status = 'received'")).rows.map((r) => r.event_id as string);
    expect(pending).toHaveLength(1);
    await waitFor(async () => (await status(pending[0])) === 'processed', 15000, 'worker processed the queued event');
    expect(await schedulers('payouts')).toEqual(expect.arrayContaining(['daily-payouts', 'payout-sweeper']));
    expect(await schedulers('monitor')).toEqual(['monitor-checks']);
  });

  it('the worker serves liveness, readiness and (admin-only) metrics on its own port', async () => {
    server = await startWorkerServer(worker!, { ...loadConfig(), workerHealthPort: 0 });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain('queue_jobs{queue="webhooks"');
    expect((await fetch(`${base}/payments`)).status).toBe(404); // the worker port is not an API
  });
});
