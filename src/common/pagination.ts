import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Shared `?limit=&cursor=` query parameters for every list endpoint. */
export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page\'s `nextCursor`' })
  @IsOptional() @IsString() @MaxLength(512)
  cursor?: string;
}

export interface Page<R> {
  data: R[];
  /** Pass as `?cursor=` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export const resolveLimit = (limit: number | undefined): number => Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);

type CursorPayload = Record<string, string | number>;

/** Cursors are opaque to clients: base64url JSON of the sort key of the last row. They carry no secrets and are always bound as SQL parameters. */
export const encodeCursor = (payload: CursorPayload): string => Buffer.from(JSON.stringify(payload)).toString('base64url');

function invalidCursor(): never {
  throw new BadRequestException({ code: 'invalid_cursor', message: 'The cursor is not valid; use the nextCursor value from a previous response' });
}

/** Decodes and validates a cursor against the exact shape the endpoint expects (a tampered cursor is a 400, never a 500). */
export function decodeCursor<T extends CursorPayload>(
  cursor: string | undefined,
  shape: { [K in keyof T]: 'string' | 'number' },
  validate?: (c: T) => boolean,
): T | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidCursor();
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(shape);
  if (Object.keys(obj).length !== keys.length) return invalidCursor();
  for (const k of keys) if (typeof obj[k] !== shape[k as keyof T]) return invalidCursor();
  if (validate && !validate(obj as T)) return invalidCursor();
  return obj as T;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `created_at::text` as Postgres renders it, e.g. `2026-10-20 10:15:33.123456+00`. Kept as text so microseconds survive the round trip. */
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
export const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);
export const isPgTimestamp = (v: unknown): boolean => typeof v === 'string' && PG_TIMESTAMP.test(v);

/** Small helper to assemble `WHERE` clauses with positional parameters. */
export class Where {
  readonly params: unknown[] = [];
  private readonly clauses: string[] = [];
  /** `sql` uses `?` for the single parameter, e.g. `seller_id = ?`. */
  add(sql: string, value: unknown): this {
    this.params.push(value);
    this.clauses.push(sql.replace('?', `$${this.params.length}`));
    return this;
  }
  /** Adds a clause with several parameters, written `?1`, `?2`, ... in order. */
  addMany(sql: string, values: unknown[]): this {
    const base = this.params.length;
    this.params.push(...values);
    this.clauses.push(sql.replace(/\?(\d)/g, (_, n) => `$${base + Number(n)}`));
    return this;
  }
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  get sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

/** Callers fetch `limit + 1` rows; the extra one only tells us whether another page exists. */
export function pageOf<R>(rows: R[], limit: number, cursorOf: (row: R) => CursorPayload): Page<R> {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  return { data, nextCursor: encodeCursor(cursorOf(data[data.length - 1])) };
}
