import { Injectable, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { decodeCursor, isPgTimestamp, isUuid, Page, pageOf, resolveLimit, Where } from '../common/pagination';
import { DbService, Queryable } from '../db/db.service';
import { AccountRef, AccountType, naturalBalance } from './accounts';
import { PostingLine } from './entries';

export interface EntryInput {
  kind: string;
  /** Unique per business event; posting the same key twice is a no-op. */
  referenceKey: string;
  externalRef?: string;
  paymentId?: string;
  payoutId?: string;
  description?: string;
  effectiveAt?: Date;
  lines: PostingLine[];
}

export class UnbalancedEntryError extends Error {}

/** Throws unless the lines have >= 2 postings, no zero amounts and sum to zero per currency. */
export function assertBalanced(lines: PostingLine[]): void {
  if (lines.length < 2) throw new UnbalancedEntryError('An entry needs at least two postings');
  const sums = new Map<string, number>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount === 0) {
      throw new UnbalancedEntryError(`Posting amounts must be non-zero integers (got ${l.amount})`);
    }
    sums.set(l.account.currency, (sums.get(l.account.currency) ?? 0) + l.amount);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0) throw new UnbalancedEntryError(`Entry is unbalanced in ${currency} by ${sum}`);
  }
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: DbService) {}

  /**
   * Append a balanced journal entry inside the caller's transaction and update the
   * cached balances in that same transaction. Returns created=false if `referenceKey`
   * was already posted (idempotent). The DB additionally enforces balance at COMMIT.
   */
  async post(client: PoolClient, input: EntryInput): Promise<{ entryId: string; created: boolean }> {
    assertBalanced(input.lines);

    // Fixed ordering (by account code) so concurrent transactions never lock in opposite order.
    const byCode = new Map<string, { account: AccountRef; amount: number }>();
    for (const l of input.lines) {
      const cur = byCode.get(l.account.code);
      byCode.set(l.account.code, { account: l.account, amount: (cur?.amount ?? 0) + l.amount });
    }
    const ordered = [...byCode.values()].sort((a, b) => (a.account.code < b.account.code ? -1 : 1));

    const entry = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (kind, reference_key, external_ref, payment_id, payout_id, description, effective_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now()))
       ON CONFLICT (reference_key) DO NOTHING RETURNING id`,
      [
        input.kind,
        input.referenceKey,
        input.externalRef ?? null,
        input.paymentId ?? null,
        input.payoutId ?? null,
        input.description ?? null,
        input.effectiveAt ?? null,
      ],
    );
    if (entry.rowCount === 0) {
      const existing = await client.query<{ id: string }>('SELECT id FROM journal_entries WHERE reference_key = $1', [
        input.referenceKey,
      ]);
      return { entryId: existing.rows[0].id, created: false };
    }
    const entryId = entry.rows[0].id;

    const resolved: { id: string; currency: string; amount: number }[] = [];
    for (const { account, amount } of ordered) {
      resolved.push({ id: await this.ensureAccount(client, account), currency: account.currency, amount });
    }
    // Lock/update cached balances in account-id order.
    resolved.sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const r of resolved) {
      if (r.amount === 0) continue; // net-zero merge of repeated account; nothing to post
      await client.query(
        'INSERT INTO postings (entry_id, account_id, currency, amount) VALUES ($1,$2,$3,$4)',
        [entryId, r.id, r.currency, r.amount],
      );
      await client.query(
        'UPDATE account_balances SET balance = balance + $2, updated_at = now() WHERE account_id = $1',
        [r.id, r.amount],
      );
    }
    return { entryId, created: true };
  }

  async ensureAccount(client: Queryable, account: AccountRef): Promise<string> {
    const res = await client.query<{ id: string; currency: string; type: string }>(
      `INSERT INTO accounts (code, type, currency) VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
       RETURNING id, currency, type`,
      [account.code, account.type, account.currency],
    );
    const row = res.rows[0];
    if (row.currency.trim() !== account.currency || row.type !== account.type) {
      throw new Error(`Account ${account.code} already exists with a different type/currency`);
    }
    await client.query('INSERT INTO account_balances (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [row.id]);
    return row.id;
  }

  /** Cached balance in the account's natural direction (0 if the account does not exist yet). */
  async balance(code: string, client: Queryable = this.db.pool): Promise<number> {
    const r = await client.query<{ type: AccountType; balance: number }>(
      `SELECT a.type, b.balance FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.code = $1`,
      [code],
    );
    return r.rows[0] ? naturalBalance(r.rows[0].type, r.rows[0].balance) : 0;
  }

  /** Balance recomputed from postings only; used to verify the cache. */
  async derivedBalance(code: string, client: Queryable = this.db.pool): Promise<number> {
    const r = await client.query<{ type: AccountType; total: number }>(
      `SELECT a.type, COALESCE(sum(p.amount), 0) AS total
         FROM accounts a LEFT JOIN postings p ON p.account_id = a.id
        WHERE a.code = $1 GROUP BY a.type`,
      [code],
    );
    return r.rows[0] ? naturalBalance(r.rows[0].type, r.rows[0].total) : 0;
  }

  /** Journal entries (newest first) with their postings. Keyset-paginated; filter by kind, payment, payout, account or time. */
  async entries(q: { limit?: number; cursor?: string; kind?: string; paymentId?: string; payoutId?: string; accountCode?: string; from?: string; to?: string }): Promise<Page<Record<string, unknown>>> {
    const limit = resolveLimit(q.limit);
    const cursor = decodeCursor<{ t: string; i: string }>(q.cursor, { t: 'string', i: 'string' }, (c) => isPgTimestamp(c.t) && isUuid(c.i));
    const w = new Where();
    if (q.kind) w.add('e.kind = ?', q.kind);
    if (q.paymentId) w.add('e.payment_id = ?::uuid', q.paymentId);
    if (q.payoutId) w.add('e.payout_id = ?::uuid', q.payoutId);
    if (q.accountCode) {
      w.add('EXISTS (SELECT 1 FROM postings px JOIN accounts ax ON ax.id = px.account_id WHERE px.entry_id = e.id AND ax.code = ?)', q.accountCode);
    }
    if (q.from) w.add('e.created_at >= ?::timestamptz', q.from);
    if (q.to) w.add('e.created_at < ?::timestamptz', q.to);
    if (cursor) w.addMany('(e.created_at, e.id) < (?1::timestamptz, ?2::uuid)', [cursor.t, cursor.i]);
    const r = await this.db.query<{
      id: string; kind: string; reference_key: string; external_ref: string | null; payment_id: string | null; payout_id: string | null;
      description: string | null; created_at: Date; cursor_ts: string; postings: { accountCode: string; currency: string; amount: number }[];
    }>(
      `SELECT e.id, e.kind, e.reference_key, e.external_ref, e.payment_id, e.payout_id, e.description, e.created_at, e.created_at::text AS cursor_ts,
              (SELECT json_agg(json_build_object('accountCode', a.code, 'currency', trim(p.currency), 'amount', p.amount) ORDER BY p.id)
                 FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = e.id) AS postings
         FROM journal_entries e ${w.sql} ORDER BY e.created_at DESC, e.id DESC LIMIT ${w.param(limit + 1)}`,
      w.params,
    );
    const page = pageOf(r.rows, limit, (row) => ({ t: row.cursor_ts, i: row.id }));
    return {
      data: page.data.map((e) => ({
        id: e.id,
        kind: e.kind,
        referenceKey: e.reference_key,
        externalRef: e.external_ref,
        paymentId: e.payment_id,
        payoutId: e.payout_id,
        description: e.description,
        createdAt: e.created_at.toISOString(),
        postings: e.postings ?? [],
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * An account's postings, newest first, each with the running balance right after it (in the account's natural
   * direction). Read in one snapshot so the starting balance and the rows agree; the cursor carries the running
   * balance, so the chain stays exact across pages even while new postings arrive.
   */
  async statement(code: string, q: { limit?: number; cursor?: string }) {
    const limit = resolveLimit(q.limit);
    const cursor = decodeCursor<{ id: number; bal: number }>(q.cursor, { id: 'number', bal: 'number' }, (c) => Number.isSafeInteger(c.id) && Number.isSafeInteger(c.bal));
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const acct = (await client.query<{ id: string; code: string; type: AccountType; currency: string; balance: number }>(
        `SELECT a.id, a.code, a.type, a.currency, b.balance FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.code = $1`,
        [code],
      )).rows[0];
      if (!acct) throw new NotFoundException(`No account ${code}`);
      const w = new Where().add('p.account_id = ?::uuid', acct.id);
      if (cursor) w.add('p.id < ?', cursor.id);
      const rows = (await client.query<{
        id: number; amount: number; entry_id: string; kind: string; description: string | null; payment_id: string | null;
        payout_id: string | null; external_ref: string | null; created_at: Date;
      }>(
        `SELECT p.id, p.amount, e.id AS entry_id, e.kind, e.description, e.payment_id, e.payout_id, e.external_ref, e.created_at
           FROM postings p JOIN journal_entries e ON e.id = p.entry_id ${w.sql} ORDER BY p.id DESC LIMIT ${w.param(limit + 1)}`,
        w.params,
      )).rows;
      await client.query('COMMIT');

      let running = cursor ? cursor.bal : naturalBalance(acct.type, acct.balance);
      const mapped = rows.map((r) => {
        const delta = naturalBalance(acct.type, r.amount);
        const row = {
          postingId: r.id,
          entryId: r.entry_id,
          kind: r.kind,
          description: r.description,
          paymentId: r.payment_id,
          payoutId: r.payout_id,
          externalRef: r.external_ref,
          createdAt: r.created_at.toISOString(),
          side: r.amount > 0 ? ('debit' as const) : ('credit' as const),
          amount: Math.abs(r.amount),
          delta,
          balanceAfter: running,
        };
        running -= delta;
        return row;
      });
      const page = pageOf(mapped, limit, (row) => ({ id: row.postingId, bal: row.balanceAfter - row.delta }));
      return {
        account: { code: acct.code, type: acct.type, currency: acct.currency.trim(), balance: naturalBalance(acct.type, acct.balance) },
        data: page.data,
        nextCursor: page.nextCursor,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** One account with its derived balance and whether the cached balance agrees; undefined if it does not exist. */
  async accountView(code: string, client: Queryable = this.db.pool) {
    const r = await client.query<{ code: string; type: AccountType; currency: string; cached: number; derived: number }>(
      `SELECT a.code, a.type, a.currency, b.balance AS cached, COALESCE(sum(p.amount), 0) AS derived
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
         LEFT JOIN postings p ON p.account_id = a.id
        WHERE a.code = $1
        GROUP BY a.code, a.type, a.currency, b.balance`,
      [code],
    );
    const a = r.rows[0];
    if (!a) return undefined;
    return {
      code: a.code,
      type: a.type,
      currency: a.currency.trim(),
      balance: naturalBalance(a.type, a.derived),
      cacheConsistent: a.cached === a.derived,
    };
  }

  /** All accounts with cached + derived balances, and per-currency totals that must be zero. */
  async trialBalance(client: Queryable = this.db.pool) {
    const accounts = await client.query<{
      code: string;
      type: AccountType;
      currency: string;
      cached: number;
      derived: number;
    }>(
      `SELECT a.code, a.type, a.currency, b.balance AS cached, COALESCE(sum(p.amount),0) AS derived
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
         LEFT JOIN postings p ON p.account_id = a.id
        GROUP BY a.code, a.type, a.currency, b.balance ORDER BY a.code`,
    );
    const totals = await client.query<{ currency: string; total: number }>(
      'SELECT currency, sum(amount) AS total FROM postings GROUP BY currency',
    );
    return {
      accounts: accounts.rows.map((a) => ({
        code: a.code,
        type: a.type,
        currency: a.currency.trim(),
        balance: naturalBalance(a.type, a.derived),
        cacheConsistent: a.cached === a.derived,
      })),
      currencyTotals: totals.rows.map((t) => ({ currency: t.currency.trim(), total: t.total })),
      balanced: totals.rows.every((t) => t.total === 0) && accounts.rows.every((a) => a.cached === a.derived),
    };
  }
}
