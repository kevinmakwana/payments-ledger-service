import { BadRequestException } from '@nestjs/common';
import { DEFAULT_LIMIT, decodeCursor, encodeCursor, isPgTimestamp, isUuid, MAX_LIMIT, pageOf, resolveLimit, Where } from './pagination';

describe('cursors', () => {
  const shape = { t: 'string', i: 'string' } as const;

  it('round-trips a payload through an opaque URL-safe string', () => {
    const cursor = encodeCursor({ t: '2026-10-20 10:00:00.123456+00', i: 'abc' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, shape)).toEqual({ t: '2026-10-20 10:00:00.123456+00', i: 'abc' });
  });

  it('treats a missing cursor as "start from the beginning"', () => {
    expect(decodeCursor(undefined, shape)).toBeUndefined();
  });

  it.each([
    ['not base64 json', '!!!not-a-cursor!!!'],
    ['json but not an object', Buffer.from('"str"').toString('base64url')],
    ['missing key', encodeCursor({ t: 'x' })],
    ['extra key', encodeCursor({ t: 'x', i: 'y', z: 'surprise' })],
    ['wrong type', encodeCursor({ t: 1, i: 'y' })],
  ])('rejects a malformed cursor (%s) with 400 invalid_cursor', (_label, cursor) => {
    expect(() => decodeCursor(cursor, shape)).toThrow(BadRequestException);
    try {
      decodeCursor(cursor, shape);
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({ code: 'invalid_cursor' });
    }
  });

  it('accepts numeric fields when the shape says number', () => {
    expect(decodeCursor(encodeCursor({ id: 42, bal: -7 }), { id: 'number', bal: 'number' } as const)).toEqual({ id: 42, bal: -7 });
  });
});

describe('resolveLimit', () => {
  it('defaults, and clamps to the maximum', () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(resolveLimit(10)).toBe(10);
    expect(resolveLimit(MAX_LIMIT + 1000)).toBe(MAX_LIMIT);
  });
});

describe('pageOf', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ n }));
  const cursorOf = (r: { n: number }) => ({ i: String(r.n) });

  it('returns a next cursor pointing at the last returned row when more rows exist', () => {
    const page = pageOf(rows.slice(0, 3), 2, cursorOf); // limit+1 rows were fetched
    expect(page.data).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decodeCursor(page.nextCursor!, { i: 'string' } as const)).toEqual({ i: '2' });
  });

  it('has no next cursor on the last page', () => {
    expect(pageOf(rows.slice(0, 2), 2, cursorOf)).toEqual({ data: [{ n: 1 }, { n: 2 }], nextCursor: null });
    expect(pageOf([], 2, cursorOf)).toEqual({ data: [], nextCursor: null });
  });
});

describe('cursor field validators', () => {
  it('accepts a Postgres text timestamp and a uuid, and nothing that could reach the database as garbage', () => {
    expect(isPgTimestamp('2026-10-20 10:15:33.123456+00')).toBe(true);
    expect(isPgTimestamp('2026-10-20 10:15:33+05:30')).toBe(true);
    expect(isPgTimestamp('garbage')).toBe(false);
    expect(isPgTimestamp("2026-10-20'; DROP TABLE payments;--")).toBe(false);
    expect(isUuid('8c1f0c52-6f55-4e0e-9f3c-6f1a7a1d2b3c')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('rejects a well-formed cursor whose values fail validation', () => {
    const bad = encodeCursor({ t: 'garbage', i: 'nope' });
    expect(() => decodeCursor(bad, { t: 'string', i: 'string' } as const, (c) => isPgTimestamp(c.t) && isUuid(c.i))).toThrow(BadRequestException);
  });
});

describe('Where', () => {
  it('numbers parameters in order and joins clauses with AND', () => {
    const w = new Where().add('seller_id = ?', 'a').add('status = ?', 'captured').addMany('(created_at, id) < (?1::timestamptz, ?2::uuid)', ['t', 'i']);
    expect(w.sql).toBe('WHERE seller_id = $1 AND status = $2 AND (created_at, id) < ($3::timestamptz, $4::uuid)');
    expect(w.params).toEqual(['a', 'captured', 't', 'i']);
    expect(w.param(51)).toBe('$5');
  });

  it('produces no WHERE at all when there are no filters', () => {
    expect(new Where().sql).toBe('');
  });
});

