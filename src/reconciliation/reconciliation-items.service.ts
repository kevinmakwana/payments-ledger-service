import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { decodeCursor, isPgTimestamp, isUuid, Page, pageOf, resolveLimit, Where } from '../common/pagination';
import { DbService } from '../db/db.service';
import { ProviderFeesService } from '../ledger/provider-fees.service';
import type { Mismatch } from './reconciliation.service';

export type ItemStatus = 'open' | 'resolved' | 'ignored';

interface ItemRow {
  id: string;
  provider: string;
  kind: string;
  ref: string;
  date: string;
  type: string;
  currency: string;
  provider_amount: number | null;
  ledger_amount: number | null;
  entry_id: string | null;
  status: ItemStatus;
  resolution: string | null;
  note: string | null;
  resolved_by: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
}

export const toItemView = (r: ItemRow) => ({
  id: r.id,
  provider: r.provider,
  kind: r.kind,
  ref: r.ref,
  date: r.date,
  type: r.type,
  currency: r.currency.trim(),
  providerAmount: r.provider_amount,
  ledgerAmount: r.ledger_amount,
  entryId: r.entry_id,
  status: r.status,
  resolution: r.resolution,
  note: r.note,
  resolvedBy: r.resolved_by,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  resolvedAt: r.resolved_at,
});
export type ItemView = ReturnType<typeof toItemView>;

const SELECT = `SELECT *, date::text AS date, first_seen_at::text AS cursor_ts FROM reconciliation_items`;

/**
 * The lifecycle of reconciliation discrepancies.
 *
 *   open ──ignore(note)──▶ ignored ──reopen──▶ open
 *     │                       │
 *     └──── a later run finds the transaction matched ────▶ resolved (auto_matched)
 *   resolved ──the same discrepancy shows up again──▶ open (counted as new)
 *
 * An ignored item stays ignored only while the discrepancy is unchanged; if its type or amounts change, an operator's
 * earlier "this is fine" no longer applies and it reopens.
 */
@Injectable()
export class ReconciliationItemsService {
  private readonly logger = new Logger(ReconciliationItemsService.name);

  constructor(
    private readonly db: DbService,
    private readonly fees: ProviderFeesService,
  ) {}

  /**
   * Records the discrepancies found for one provider and day and closes items for that day that are no longer
   * discrepancies. Returns the mismatches annotated with their item id, status and whether they are new.
   */
  async sync(provider: string, date: string, mismatches: Mismatch[]): Promise<{ mismatches: Mismatch[]; autoResolved: number }> {
    return this.db.tx(async (client) => {
      const out: Mismatch[] = [];
      for (const m of mismatches) {
        const same = {
          type: m.type,
          providerAmount: m.providerAmount ?? null,
          ledgerAmount: m.ledgerAmount ?? null,
        };
        const found = (
          await client.query<ItemRow>('SELECT * FROM reconciliation_items WHERE provider = $1 AND kind = $2 AND ref = $3 FOR UPDATE', [provider, m.kind, m.ref])
        ).rows[0];
        const values = [m.type, date, m.currency, same.providerAmount, same.ledgerAmount, m.entryId ?? null];
        if (!found) {
          const ins = await client.query<ItemRow>(
            `INSERT INTO reconciliation_items (provider, kind, ref, type, date, currency, provider_amount, ledger_amount, entry_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [provider, m.kind, m.ref, ...values],
          );
          out.push({ ...m, itemId: ins.rows[0].id, status: 'open', isNew: true });
          continue;
        }
        const unchanged = found.type === same.type && found.provider_amount === same.providerAmount && found.ledger_amount === same.ledgerAmount;
        if (found.status === 'ignored' && unchanged) {
          await client.query('UPDATE reconciliation_items SET last_seen_at = now(), date = $2 WHERE id = $1', [found.id, date]);
          out.push({ ...m, itemId: found.id, status: 'ignored', isNew: false });
        } else if (found.status === 'open') {
          await client.query(
            `UPDATE reconciliation_items SET type = $2, date = $3, currency = $4, provider_amount = $5, ledger_amount = $6, entry_id = $7, last_seen_at = now() WHERE id = $1`,
            [found.id, ...values],
          );
          out.push({ ...m, itemId: found.id, status: 'open', isNew: false });
        } else {
          // Resolved earlier (it came back), or ignored but the discrepancy has changed: a fresh episode.
          await client.query(
            `UPDATE reconciliation_items SET type = $2, date = $3, currency = $4, provider_amount = $5, ledger_amount = $6, entry_id = $7,
                    status = 'open', resolution = NULL, resolved_at = NULL, resolved_by = NULL, first_seen_at = now(), last_seen_at = now()
              WHERE id = $1`,
            [found.id, ...values],
          );
          out.push({ ...m, itemId: found.id, status: 'open', isNew: true });
        }
      }
      const current = mismatches.map((m) => `${m.kind}:${m.ref}`);
      const closed = await client.query(
        `UPDATE reconciliation_items SET status = 'resolved', resolution = 'auto_matched', resolved_at = now(), resolved_by = 'reconciliation'
          WHERE provider = $1 AND date = $2 AND status IN ('open', 'ignored') AND NOT ((kind || ':' || ref) = ANY($3::text[]))`,
        [provider, date, current],
      );
      return { mismatches: out, autoResolved: closed.rowCount ?? 0 };
    });
  }

  async list(q: { limit?: number; cursor?: string; status?: string; provider?: string; type?: string; date?: string }): Promise<Page<ItemView>> {
    const limit = resolveLimit(q.limit);
    const cursor = decodeCursor<{ t: string; i: string }>(q.cursor, { t: 'string', i: 'string' }, (c) => isPgTimestamp(c.t) && isUuid(c.i));
    const w = new Where();
    if (q.status) w.add('status = ?', q.status);
    if (q.provider) w.add('provider = ?', q.provider);
    if (q.type) w.add('type = ?', q.type);
    if (q.date) w.add('date = ?::date', q.date);
    if (cursor) w.addMany('(first_seen_at, id) < (?1::timestamptz, ?2::uuid)', [cursor.t, cursor.i]);
    const r = await this.db.query<ItemRow & { cursor_ts: string }>(
      `${SELECT} ${w.sql} ORDER BY first_seen_at DESC, id DESC LIMIT ${w.param(limit + 1)}`,
      w.params,
    );
    const page = pageOf(r.rows, limit, (row) => ({ t: row.cursor_ts, i: row.id }));
    return { data: page.data.map(toItemView), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<ItemView> {
    const r = await this.db.query<ItemRow>(`${SELECT} WHERE id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundException({ code: 'not_found', message: 'Reconciliation item not found' });
    return toItemView(r.rows[0]);
  }

  /** Accept a discrepancy as known and expected. Needs a note, so there is always a record of why. Idempotent. */
  async ignore(id: string, note: string, by: string): Promise<ItemView> {
    const row = await this.lock(id, async (cur, client) => {
      if (cur.status === 'ignored') return cur;
      if (cur.status === 'resolved') throw new ConflictException({ code: 'item_resolved', message: 'This item is already resolved' });
      const u = await client.query<ItemRow>(
        `UPDATE reconciliation_items SET status = 'ignored', resolution = 'ignored', note = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 RETURNING *, date::text AS date`,
        [id, note, by],
      );
      return u.rows[0];
    });
    this.logger.warn({ msg: 'reconciliation_item_ignored', itemId: id, by });
    return toItemView(row);
  }

  /** Take an ignored item back into the open queue. Resolved items cannot be reopened: they reopen themselves if the problem returns. */
  async reopen(id: string, by: string): Promise<ItemView> {
    const row = await this.lock(id, async (cur, client) => {
      if (cur.status === 'open') return cur;
      if (cur.status === 'resolved') throw new ConflictException({ code: 'item_resolved', message: 'This item is resolved; it reopens by itself if the discrepancy comes back' });
      const u = await client.query<ItemRow>(
        `UPDATE reconciliation_items SET status = 'open', resolution = NULL, resolved_at = NULL, resolved_by = NULL WHERE id = $1 RETURNING *, date::text AS date`,
        [id],
      );
      return u.rows[0];
    });
    this.logger.warn({ msg: 'reconciliation_item_reopened', itemId: id, by });
    return toItemView(row);
  }

  /**
   * Resolves a `fee_mismatch` by making the ledger's booked fee equal the provider's (posting the difference as an
   * adjustment entry). Use it when the provider's figure is the truth, which for a processing fee it is.
   */
  async bookFee(id: string, by: string): Promise<ItemView> {
    const item = await this.db.query<ItemRow & { payment_id: string | null }>(
      `SELECT i.*, i.date::text AS date, e.payment_id FROM reconciliation_items i LEFT JOIN journal_entries e ON e.id = i.entry_id WHERE i.id = $1`,
      [id],
    );
    const cur = item.rows[0];
    if (!cur) throw new NotFoundException({ code: 'not_found', message: 'Reconciliation item not found' });
    if (cur.status === 'resolved') throw new ConflictException({ code: 'item_resolved', message: 'This item is already resolved' });
    if (cur.type !== 'fee_mismatch' || cur.provider_amount === null || !cur.payment_id) {
      throw new ConflictException({ code: 'not_a_fee_mismatch', message: 'Only fee mismatches can be fixed by booking the provider fee' });
    }
    await this.fees.setFee(cur.payment_id, cur.provider_amount, cur.currency.trim(), cur.ref);
    const u = await this.db.query<ItemRow>(
      `UPDATE reconciliation_items SET status = 'resolved', resolution = 'fee_booked', resolved_at = now(), resolved_by = $2
        WHERE id = $1 AND status <> 'resolved' RETURNING *, date::text AS date`,
      [id, by],
    );
    this.logger.warn({ msg: 'reconciliation_fee_booked', itemId: id, by, fee: cur.provider_amount });
    return toItemView(u.rows[0] ?? cur);
  }

  /** Open items that have waited at least `days` days, oldest first. */
  async stale(days: number, limit = 20): Promise<{ count: number; oldest: ItemView[] }> {
    const cutoff = `now() - make_interval(days => $1::int)`;
    const count = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reconciliation_items WHERE status = 'open' AND first_seen_at < ${cutoff}`, [days]);
    const oldest = await this.db.query<ItemRow>(`${SELECT} WHERE status = 'open' AND first_seen_at < ${cutoff} ORDER BY first_seen_at LIMIT $2`, [days, limit]);
    return { count: count.rows[0].n, oldest: oldest.rows.map(toItemView) };
  }

  private async lock(id: string, fn: (cur: ItemRow, client: import('pg').PoolClient) => Promise<ItemRow>): Promise<ItemRow> {
    return this.db.tx(async (client) => {
      const cur = (await client.query<ItemRow>('SELECT *, date::text AS date FROM reconciliation_items WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) throw new NotFoundException({ code: 'not_found', message: 'Reconciliation item not found' });
      return fn(cur, client);
    });
  }
}
