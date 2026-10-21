import { ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { ApiKeyService } from './api-key.service';
import { generateToken } from './api-keys';

const BOOTSTRAP = 'sk_bootstrap_0123456789abcdef';

function service(query: jest.Mock, env: Record<string, string> = {}) {
  const config = loadConfig({ API_KEYS: `${BOOTSTRAP}:admin`, ...env });
  return new ApiKeyService({ query } as unknown as DbService, config);
}
const found = (role = 'client', expires: Date | null = null) => jest.fn().mockResolvedValue({ rows: [{ id: 'key-1', role, expires_at: expires }] });

describe('ApiKeyService.authenticate', () => {
  it('never queries the database for tokens that are not in the issued format', async () => {
    const query = jest.fn();
    const svc = service(query);
    for (const t of ['garbage', 'sk_other_0123456789abcdef', '', undefined]) expect(await svc.authenticate(t)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('answers bootstrap keys without a query, so they keep working when the database is down', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));
    expect(await service(query).authenticate(BOOTSTRAP)).toMatchObject({ role: 'admin', source: 'env' });
    expect(query).not.toHaveBeenCalled();
  });

  it('answers 503 (not 401, not a crash) for an issued key when the database cannot be reached', async () => {
    const svc = service(jest.fn().mockRejectedValue(new Error('connection refused')));
    await expect(svc.authenticate(generateToken())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('caches a found key for API_KEY_CACHE_TTL_MS, then looks it up again', async () => {
    const query = found();
    const svc = service(query, { API_KEY_CACHE_TTL_MS: '50' });
    const token = generateToken();
    expect(await svc.authenticate(token)).toEqual({ role: 'client', keyId: 'key-1', source: 'database' });
    await svc.authenticate(token);
    expect(query.mock.calls.filter(([sql]) => /SELECT/.test(sql))).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 80));
    await svc.authenticate(token);
    expect(query.mock.calls.filter(([sql]) => /SELECT/.test(sql))).toHaveLength(2);
  });

  it('does not cache a miss: a key issued a moment ago is usable immediately', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [{ id: 'key-2', role: 'admin', expires_at: null }] });
    const svc = service(query);
    const token = generateToken();
    expect(await svc.authenticate(token)).toBeUndefined();
    expect(await svc.authenticate(token)).toMatchObject({ role: 'admin' });
  });

  it('stops serving a cached key as soon as its own expiry passes, whatever the cache TTL', async () => {
    const svc = service(found('client', new Date(Date.now() + 60)), { API_KEY_CACHE_TTL_MS: '60000' });
    const token = generateToken();
    expect(await svc.authenticate(token)).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    // second lookup misses the cache and the (mocked) database still returns the row, so only the cache check is under test
    const query = jest.fn().mockResolvedValue({ rows: [] });
    (svc as unknown as { db: { query: jest.Mock } }).db.query = query;
    expect(await svc.authenticate(token)).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
