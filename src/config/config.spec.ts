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
