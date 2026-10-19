import { loadConfig } from './config';

const KEY = 'sk_admin_0123456789abcdef';

describe('loadConfig authentication settings', () => {
  it('parses API_KEYS into the config', () => {
    expect(loadConfig({ API_KEYS: `${KEY}:admin` }).apiKeys).toEqual([{ key: KEY, role: 'admin' }]);
  });

  it('allows running without keys outside production (local dev, demo, tests)', () => {
    expect(loadConfig({}).apiKeys).toEqual([]);
    expect(loadConfig({ NODE_ENV: 'development' }).apiKeys).toEqual([]);
  });

  it('refuses to start in production without API_KEYS', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/API_KEYS/);
  });

  it('lets production run unauthenticated only through an explicit opt-out', () => {
    expect(loadConfig({ NODE_ENV: 'production', ALLOW_UNAUTHENTICATED: 'true' }).apiKeys).toEqual([]);
  });

  it('starts in production when keys are set', () => {
    expect(loadConfig({ NODE_ENV: 'production', API_KEYS: `${KEY}:client` }).apiKeys).toHaveLength(1);
  });

  it('propagates malformed keys instead of silently disabling auth', () => {
    expect(() => loadConfig({ API_KEYS: 'short:admin' })).toThrow(/API_KEYS/);
  });
});

describe('loadConfig process role', () => {
  it('defaults to running everything in one process, with schedulers on', () => {
    const c = loadConfig({});
    expect(c.role).toBe('all');
    expect(c.schedulersEnabled).toBe(true);
    expect(c.workerHealthPort).toBe(3001);
  });

  it('an api process serves HTTP only: it never registers the scheduled jobs', () => {
    const c = loadConfig({ APP_ROLE: 'api' });
    expect(c.role).toBe('api');
    expect(c.schedulersEnabled).toBe(false);
  });

  it('a worker process runs the queues and schedulers', () => {
    const c = loadConfig({ APP_ROLE: 'worker', WORKER_PORT: '4001' });
    expect(c.role).toBe('worker');
    expect(c.schedulersEnabled).toBe(true);
    expect(c.workerHealthPort).toBe(4001);
  });

  it('SCHEDULERS_ENABLED=false still turns schedulers off for every role', () => {
    expect(loadConfig({ APP_ROLE: 'worker', SCHEDULERS_ENABLED: 'false' }).schedulersEnabled).toBe(false);
    expect(loadConfig({ SCHEDULERS_ENABLED: 'false' }).schedulersEnabled).toBe(false);
  });

  it('rejects an unknown role instead of silently running as something else', () => {
    expect(() => loadConfig({ APP_ROLE: 'bogus' })).toThrow(/APP_ROLE/);
  });
});

