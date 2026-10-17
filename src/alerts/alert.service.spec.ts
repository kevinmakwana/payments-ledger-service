import { Logger } from '@nestjs/common';
import { FakeHttp, respondJson, startFakeHttp } from '../../test/fake-http';
import { loadConfig } from '../config/config';
import { AlertService } from './alert.service';

let fake: FakeHttp | undefined;
afterEach(async () => {
  jest.restoreAllMocks();
  await fake?.close();
  fake = undefined;
});

const serviceFor = (env: Record<string, string> = {}) => new AlertService(loadConfig({ ALERT_TIMEOUT_MS: '100', ...env }));
const alert = { kind: 'ledger_drift', severity: 'critical' as const, message: 'cache disagrees with postings', details: { accounts: 2 } };

describe('AlertService', () => {
  it('logs every alert as an error line even when no webhook is configured', async () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void logged.push(String(m)));
    await serviceFor().raise(alert);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('ledger_drift');
    expect(logged[0]).toContain('cache disagrees with postings');
  });

  it('POSTs the alert as JSON to ALERT_WEBHOOK_URL', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, { ok: true }));
    await serviceFor({ ALERT_WEBHOOK_URL: `${fake.url}/hook` }).raise(alert);
    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/hook');
    expect(req.headers['content-type']).toContain('application/json');
    expect(JSON.parse(req.body)).toMatchObject({ service: 'payments-ledger-service', ...alert });
    expect(JSON.parse(req.body).at).toEqual(expect.any(String));
  });

  it('never throws when the endpoint answers with an error', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fake = await startFakeHttp((_req, res) => respondJson(res, 500, { error: 'boom' }));
    await expect(serviceFor({ ALERT_WEBHOOK_URL: fake.url }).raise(alert)).resolves.toBeUndefined();
  });

  it('never throws or blocks for long when the endpoint hangs', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fake = await startFakeHttp(() => undefined);
    const started = Date.now();
    await expect(serviceFor({ ALERT_WEBHOOK_URL: fake.url }).raise(alert)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never throws when the endpoint is unreachable', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(serviceFor({ ALERT_WEBHOOK_URL: 'http://127.0.0.1:1' }).raise(alert)).resolves.toBeUndefined();
  });
});
