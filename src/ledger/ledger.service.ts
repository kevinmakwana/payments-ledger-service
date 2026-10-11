import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
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
