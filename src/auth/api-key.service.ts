import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { decodeCursor, isPgTimestamp, isUuid, Page, pageOf, resolveLimit } from '../common/pagination';
import { DbService } from '../db/db.service';
import { authenticateStatic, generateToken, hashToken, looksLikeIssuedToken, Principal, Role, TOKEN_PREFIX } from './api-keys';

interface KeyRow {
  id: string;
  name: string;
  role: Role;
  key_prefix: string;
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  replaced_by: string | null;
}

export interface ApiKeyView {
  id: string;
  name: string;
  role: Role;
  /** First characters of the token, enough to recognise it in a list. Not secret. */
  keyPrefix: string;
  status: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  createdBy: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  replacedBy: string | null;
}

const toView = (r: KeyRow, now = Date.now()): ApiKeyView => ({
  id: r.id,
  name: r.name,
  role: r.role,
  keyPrefix: r.key_prefix,
  status: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at.getTime() <= now ? 'expired' : 'active',
  createdAt: r.created_at,
  createdBy: r.created_by,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  lastUsedAt: r.last_used_at,
  replacedBy: r.replaced_by,
});

/** `last_used_at` is a hint for operators, not an audit log, so it is written at most this often per key per process. */
const TOUCH_INTERVAL_MS = 60_000;
const MAX_CACHED = 1000;
const day = 86_400_000;

/**
 * API keys, from two places. Keys in `API_KEYS` (environment) are the bootstrap: always valid, checked first, and they
 * keep working if the database is down. Keys issued through the admin API live in `api_keys` as SHA-256 hashes only:
 * the plaintext is shown once, at creation. They can expire, be revoked, and be rotated with an overlap window.
 *
 * Database keys are cached per process for `API_KEY_CACHE_TTL_MS` so a request costs no query. Revoking is immediate
 * on the instance that handles it and takes at most that long on the others.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private readonly cache = new Map<string, { principal: Principal; keyExpiresAt: number | null; validUntil: number }>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Authentication is on when at least one bootstrap key is configured. */
  get enabled(): boolean {
    return this.config.apiKeys.length > 0;
  }

  async authenticate(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined;
    const fromEnv = authenticateStatic(this.config.apiKeys, token);
    if (fromEnv) return fromEnv;
    if (!looksLikeIssuedToken(token)) return undefined; // not our format: no reason to query
    const digest = hashToken(token);
    const cacheKey = digest.toString('hex');
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.validUntil > now && (hit.keyExpiresAt === null || hit.keyExpiresAt > now)) return hit.principal;
    this.cache.delete(cacheKey);

    let row: { id: string; role: Role; expires_at: Date | null } | undefined;
    try {
      const r = await this.db.query<{ id: string; role: Role; expires_at: Date | null }>(
        `SELECT id, role, expires_at FROM api_keys
          WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [digest],
      );
      row = r.rows[0];
    } catch (err) {
      this.logger.error(`API key lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException({ code: 'auth_unavailable', message: 'API keys cannot be verified right now; retry shortly' });
    }
    if (!row) return undefined;
    const principal: Principal = { role: row.role, keyId: row.id, source: 'database' };
    if (this.cache.size >= MAX_CACHED) this.cache.clear(); // a flood of distinct valid keys is not a realistic case; bound memory anyway
    this.cache.set(cacheKey, { principal, keyExpiresAt: row.expires_at ? row.expires_at.getTime() : null, validUntil: now + this.config.apiKeyCacheTtlMs });
    this.touch(row.id, now);
    return principal;
  }

  async create(input: { name: string; role: Role; expiresInDays?: number }, createdBy: string): Promise<{ key: ApiKeyView; token: string }> {
    return this.insert((sql, params) => this.db.query<KeyRow>(sql, params), input, createdBy);
  }

  async list(q: { limit?: number; cursor?: string }): Promise<Page<ApiKeyView>> {
    const limit = resolveLimit(q.limit);
    const cursor = decodeCursor<{ t: string; i: string }>(q.cursor, { t: 'string', i: 'string' }, (c) => isPgTimestamp(c.t) && isUuid(c.i));
    const r = await this.db.query<KeyRow & { cursor_ts: string }>(
      `SELECT id, name, role, key_prefix, created_at, created_by, expires_at, revoked_at, last_used_at, replaced_by, created_at::text AS cursor_ts
         FROM api_keys
        ${cursor ? 'WHERE (created_at, id) < ($2::timestamptz, $3::uuid)' : ''}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      cursor ? [limit + 1, cursor.t, cursor.i] : [limit + 1],
    );
    const page = pageOf(r.rows, limit, (row) => ({ t: row.cursor_ts, i: row.id }));
    return { data: page.data.map((row) => toView(row)), nextCursor: page.nextCursor };
  }

  /** Idempotent: revoking a revoked key succeeds and keeps the original revocation time. */
  async revoke(id: string, by: string): Promise<ApiKeyView> {
    const r = await this.db.query<KeyRow>('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING *', [id]);
    if (!r.rows[0]) throw new NotFoundException({ code: 'not_found', message: 'API key not found' });
    this.forget(id);
    this.logger.warn({ msg: 'api_key_revoked', keyId: id, by });
    return toView(r.rows[0]);
  }

  /**
   * Issues a replacement (same name and role) and schedules the old key to stop working `graceSeconds` from now, so
   * clients can switch over without downtime; 0 retires it at once. A key can be rotated only once.
   */
  async rotate(id: string, input: { graceSeconds: number; expiresInDays?: number }, by: string): Promise<{ key: ApiKeyView; token: string; previous: ApiKeyView }> {
    const out = await this.db.tx(async (client) => {
      const cur = (await client.query<KeyRow>('SELECT * FROM api_keys WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException({ code: 'not_found', message: 'API key not found' });
      const state = toView(cur).status;
      if (state !== 'active') throw new ConflictException({ code: 'api_key_not_active', message: `This key is ${state} and cannot be rotated` });
      if (cur.replaced_by) throw new ConflictException({ code: 'api_key_already_rotated', message: 'This key has already been rotated; rotate its replacement instead' });
      const issued = await this.insert((sql, params) => client.query<KeyRow>(sql, params), { name: cur.name, role: cur.role, expiresInDays: input.expiresInDays }, by);
      const old = (
        await client.query<KeyRow>(
          input.graceSeconds === 0
            ? 'UPDATE api_keys SET replaced_by = $2, revoked_at = now() WHERE id = $1 RETURNING *'
            : `UPDATE api_keys SET replaced_by = $2,
                 expires_at = LEAST(COALESCE(expires_at, 'infinity'::timestamptz), now() + make_interval(secs => $3::int))
               WHERE id = $1 RETURNING *`,
          input.graceSeconds === 0 ? [id, issued.key.id] : [id, issued.key.id, input.graceSeconds],
        )
      ).rows[0];
      return { ...issued, previous: toView(old) };
    });
    this.forget(id);
    this.logger.warn({ msg: 'api_key_rotated', keyId: id, replacedBy: out.key.id, graceSeconds: input.graceSeconds, by });
    return out;
  }

  private async insert(
    run: (sql: string, params: unknown[]) => Promise<{ rows: KeyRow[] }>,
    input: { name: string; role: Role; expiresInDays?: number },
    createdBy: string,
  ): Promise<{ key: ApiKeyView; token: string }> {
    const token = generateToken();
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * day) : null;
    const r = await run(
      `INSERT INTO api_keys (name, role, key_prefix, key_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [input.name, input.role, token.slice(0, TOKEN_PREFIX.length + 4), hashToken(token), createdBy, expiresAt],
    );
    const key = toView(r.rows[0]);
    this.logger.log({ msg: 'api_key_created', keyId: key.id, name: key.name, role: key.role, by: createdBy });
    return { key, token };
  }

  /** Drops this instance's cached entry for a key (matched by id) so a revocation here takes effect on the next request. */
  private forget(id: string): void {
    for (const [k, v] of this.cache) if (v.principal.keyId === id) this.cache.delete(k);
  }

  private touch(id: string, now: number): void {
    if (now - (this.lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(id, now);
    this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]).catch((err: unknown) => {
      this.logger.warn(`Could not record API key use: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
