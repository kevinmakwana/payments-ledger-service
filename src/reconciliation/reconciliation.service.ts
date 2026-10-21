import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ProviderFeesService } from '../ledger/provider-fees.service';
import { ProviderTransaction } from '../providers/provider.interface';
import { ProviderRegistry } from '../providers/provider.registry';
import { ReconciliationItemsService } from './reconciliation-items.service';

export type MismatchType = 'missing_in_ledger' | 'missing_at_provider' | 'amount_mismatch' | 'fee_mismatch';

export interface Mismatch {
  type: MismatchType;
  kind: ProviderTransaction['type'];
  ref: string;
  currency: string;
  providerAmount?: number;
  ledgerAmount?: number;
  entryId?: string;
  /** The UTC day this discrepancy belongs to: the provider's day for provider-side findings, the entry's day otherwise. */
  day?: string;
  /** Set once the mismatch has been recorded as a tracked item. */
  itemId?: string;
  /** `ignored` mismatches were accepted by an operator and do not raise alerts. */
  status?: 'open' | 'ignored';
  /** First time this discrepancy was seen (or seen again after having been resolved). */
  isNew?: boolean;
}

export interface ReconciliationReport {
  provider: string;
  date: string;
  generatedAt: string;
  summary: {
    providerTransactions: number;
    ledgerEntries: number;
    matched: number;
    /** Everything that disagrees right now, including mismatches an operator has chosen to ignore. */
    mismatches: number;
    /** Mismatches still needing attention (not ignored). */
    open: number;
    /** Open mismatches seen for the first time by this run. */
    new: number;
    /** Items from earlier runs that this run found matched (e.g. a late webhook caught the ledger up) and closed. */
    autoResolved: number;
    /** Provider fees this run found missing from the ledger and booked (e.g. Stripe computes them after the capture). */
    feesBooked: number;
  };
  mismatches: Mismatch[];
}

interface LedgerSide {
  entryId: string;
  kind: ProviderTransaction['type'];
  ref: string;
  amount: number;
  currency: string;
  /** UTC day the entry was recorded. */
  day?: string;
  /** The payment behind a charge entry. */
  paymentId?: string;
  /** Provider fee booked in the ledger for that payment (0 when none). */
  fee?: number;
}

const KIND_MAP: Record<string, ProviderTransaction['type']> = {
  capture: 'charge',
  refund: 'refund',
  payout_settled: 'payout',
};

const utcDay = (iso: string): string | undefined => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
};

/** Pure comparison, separated from I/O so it is trivially unit-testable. */
export function compare(providerTxs: ProviderTransaction[], ledger: LedgerSide[]): { matched: number; mismatches: Mismatch[] } {
  const key = (type: string, ref: string) => `${type}:${ref}`;
  const ledgerByKey = new Map(ledger.map((l) => [key(l.kind, l.ref), l]));
  const seen = new Set<string>();
  const mismatches: Mismatch[] = [];
  let matched = 0;
  for (const t of providerTxs) {
    const k = key(t.type, t.id);
    seen.add(k);
    const l = ledgerByKey.get(k);
    const day = utcDay(t.createdAt);
    if (!l) {
      mismatches.push({ type: 'missing_in_ledger', kind: t.type, ref: t.id, currency: t.currency, providerAmount: t.amount, day });
    } else if (l.amount !== t.amount || l.currency !== t.currency) {
      mismatches.push({
        type: 'amount_mismatch', kind: t.type, ref: t.id, currency: t.currency,
        providerAmount: t.amount, ledgerAmount: l.amount, entryId: l.entryId, day,
      });
    } else if (t.type === 'charge' && t.fee !== undefined && (l.fee ?? 0) !== t.fee) {
      // Only checked when the provider reports a fee, and only once the amounts agree (one finding per transaction).
      mismatches.push({
        type: 'fee_mismatch', kind: t.type, ref: t.id, currency: t.currency,
        providerAmount: t.fee, ledgerAmount: l.fee ?? 0, entryId: l.entryId, day,
      });
    } else {
      matched++;
    }
  }
  for (const l of ledger) {
    if (!seen.has(key(l.kind, l.ref))) {
      mismatches.push({ type: 'missing_at_provider', kind: l.kind, ref: l.ref, currency: l.currency, ledgerAmount: l.amount, entryId: l.entryId, day: l.day });
    }
  }
  return { matched, mismatches };
}

/**
 * Reconciles one UTC day. Both sides are matched across the day before, the day itself and the day after, because
 * a transaction near midnight is routinely dated on one side and not the other (provider clock vs the moment our
 * webhook handler wrote the entry). Only findings that belong to `date` are reported; a pair that straddles
 * midnight matches and raises nothing. `providerTxs` and `ledger` must cover the whole window.
 */
export function compareForDay(date: string, providerTxs: ProviderTransaction[], ledger: LedgerSide[]) {
  const { mismatches } = compare(providerTxs, ledger);
  const providerToday = providerTxs.filter((t) => (utcDay(t.createdAt) ?? date) === date);
  const mine = mismatches.filter((m) => (m.day ?? date) === date);
  const providerSideMismatches = mine.filter((m) => m.type !== 'missing_at_provider').length;
  return {
    providerTransactions: providerToday.length,
    ledgerEntries: ledger.filter((l) => (l.day ?? date) === date).length,
    matched: providerToday.length - providerSideMismatches,
    mismatches: mine,
  };
}

const DAY_MS = 86_400_000;
const shiftDay = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: DbService,
    private readonly providers: ProviderRegistry,
    private readonly items: ReconciliationItemsService,
    private readonly fees: ProviderFeesService,
  ) {}

  /**
   * Compares one day, records every discrepancy as a tracked item, and closes items from earlier runs that now match.
   * `listings` memoises provider listings so reconciling several adjacent days costs one provider call per day.
   */
  async reconcile(date: string, providerName?: string, listings: Map<string, Promise<ProviderTransaction[]>> = new Map()): Promise<ReconciliationReport> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD');
    }
    const provider = this.providers.get(providerName);
    const today = new Date().toISOString().slice(0, 10);
    const days = [shiftDay(date, -1), date, shiftDay(date, 1)].filter((d) => d <= today);
    const providerTxs = (
      await Promise.all(
        days.map((d) => {
          const k = `${provider.name}:${d}`;
          if (!listings.has(k)) listings.set(k, provider.listTransactions(d));
          return listings.get(k)!;
        }),
      )
    ).flat();
    const ledger = await this.ledgerSide(days[0], days[days.length - 1], provider.name);
    const feesBooked = await this.bookMissingFees(providerTxs, ledger);
    const day = compareForDay(date, providerTxs, ledger);
    const synced = await this.items.sync(provider.name, date, day.mismatches);
    const report: ReconciliationReport = {
      provider: provider.name,
      date,
      generatedAt: new Date().toISOString(),
      summary: {
        providerTransactions: day.providerTransactions,
        ledgerEntries: day.ledgerEntries,
        matched: day.matched,
        mismatches: synced.mismatches.length,
        open: synced.mismatches.filter((m) => m.status === 'open').length,
        new: synced.mismatches.filter((m) => m.isNew).length,
        autoResolved: synced.autoResolved,
        feesBooked,
      },
      mismatches: synced.mismatches,
    };
    await this.db.query(
      `INSERT INTO reconciliation_reports (provider, date, report) VALUES ($1,$2,$3)
       ON CONFLICT (provider, date) DO UPDATE SET report = EXCLUDED.report, created_at = now()`,
      [provider.name, date, JSON.stringify(report)],
    );
    return report;
  }

  /**
   * A fee the provider reports for a charge we captured without knowing it is booked now: that is the normal path
   * for providers that compute fees asynchronously, so it is not a discrepancy. Only an amount that agrees is
   * touched, and a fee already on the books is never changed here (a differing fee is a `fee_mismatch` for a person).
   */
  private async bookMissingFees(providerTxs: ProviderTransaction[], ledger: LedgerSide[]): Promise<number> {
    const byRef = new Map(ledger.filter((l) => l.kind === 'charge' && l.paymentId).map((l) => [l.ref, l]));
    let booked = 0;
    for (const t of providerTxs) {
      const l = byRef.get(t.id);
      if (t.type !== 'charge' || !t.fee || t.fee > t.amount || !l || (l.fee ?? 0) !== 0) continue;
      if (l.amount !== t.amount || l.currency !== t.currency) continue;
      await this.fees.setFee(l.paymentId!, t.fee, l.currency, t.id);
      l.fee = t.fee;
      booked++;
    }
    return booked;
  }

  /** Cash-moving ledger entries recorded in [from, to] (UTC days), with the amount that hit the provider clearing account. */
  private async ledgerSide(from: string, to: string, provider: string): Promise<LedgerSide[]> {
    const r = await this.db.query<{ id: string; kind: string; external_ref: string; amount: number; currency: string; day: string; payment_id: string | null }>(
      `SELECT e.id, e.kind, e.external_ref, e.payment_id, a.currency, sum(abs(p.amount)) AS amount,
              ((e.created_at AT TIME ZONE 'UTC')::date)::text AS day
         FROM journal_entries e
         JOIN postings p ON p.entry_id = e.id
         JOIN accounts a ON a.id = p.account_id AND a.code LIKE 'platform:clearing:%'
         LEFT JOIN payments pa ON pa.id = e.payment_id
         LEFT JOIN payouts po ON po.id = e.payout_id
        WHERE e.kind IN ('capture','refund','payout_settled')
          AND e.external_ref IS NOT NULL
          AND (e.created_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
          AND COALESCE(pa.provider, po.provider) = $3
        GROUP BY e.id, e.kind, e.external_ref, e.payment_id, a.currency, e.created_at`,
      [from, to, provider],
    );
    const paymentIds = [...new Set(r.rows.map((row) => row.payment_id).filter((id): id is string => id !== null))];
    const feeRows = paymentIds.length
      ? await this.db.query<{ payment_id: string; fee: number }>(
          `SELECT e.payment_id, sum(p.amount)::bigint AS fee
             FROM journal_entries e
             JOIN postings p ON p.entry_id = e.id
             JOIN accounts a ON a.id = p.account_id AND a.code LIKE 'platform:provider_fees:%'
            WHERE e.kind IN ('provider_fee', 'provider_fee_adjustment') AND e.payment_id = ANY($1::uuid[])
            GROUP BY e.payment_id`,
          [paymentIds],
        )
      : { rows: [] as { payment_id: string; fee: number }[] };
    const feeByPayment = new Map(feeRows.rows.map((f) => [f.payment_id, f.fee]));
    return r.rows.map((row) => ({
      entryId: row.id,
      kind: KIND_MAP[row.kind],
      ref: row.external_ref,
      amount: row.amount,
      currency: row.currency.trim(),
      day: row.day,
      paymentId: row.payment_id ?? undefined,
      fee: row.kind === 'capture' ? (feeByPayment.get(row.payment_id ?? '') ?? 0) : undefined,
    }));
  }
}
