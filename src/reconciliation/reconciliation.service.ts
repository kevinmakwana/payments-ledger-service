import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { ProviderTransaction } from '../providers/provider.interface';
import { ProviderRegistry } from '../providers/provider.registry';

export type MismatchType = 'missing_in_ledger' | 'missing_at_provider' | 'amount_mismatch';

export interface Mismatch {
  type: MismatchType;
  kind: ProviderTransaction['type'];
  ref: string;
  currency: string;
  providerAmount?: number;
  ledgerAmount?: number;
  entryId?: string;
}

export interface ReconciliationReport {
  provider: string;
  date: string;
  generatedAt: string;
  summary: { providerTransactions: number; ledgerEntries: number; matched: number; mismatches: number };
  mismatches: Mismatch[];
}

interface LedgerSide {
  entryId: string;
  kind: ProviderTransaction['type'];
  ref: string;
  amount: number;
  currency: string;
}

const KIND_MAP: Record<string, ProviderTransaction['type']> = {
  capture: 'charge',
  refund: 'refund',
  payout_settled: 'payout',
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
    if (!l) {
      mismatches.push({ type: 'missing_in_ledger', kind: t.type, ref: t.id, currency: t.currency, providerAmount: t.amount });
    } else if (l.amount !== t.amount || l.currency !== t.currency) {
      mismatches.push({
        type: 'amount_mismatch', kind: t.type, ref: t.id, currency: t.currency,
        providerAmount: t.amount, ledgerAmount: l.amount, entryId: l.entryId,
      });
    } else {
      matched++;
    }
  }
  for (const l of ledger) {
    if (!seen.has(key(l.kind, l.ref))) {
      mismatches.push({ type: 'missing_at_provider', kind: l.kind, ref: l.ref, currency: l.currency, ledgerAmount: l.amount, entryId: l.entryId });
    }
  }
  return { matched, mismatches };
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: DbService,
    private readonly providers: ProviderRegistry,
  ) {}

  async reconcile(date: string, providerName?: string): Promise<ReconciliationReport> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new BadRequestException('date must be a valid YYYY-MM-DD');
    }
    const provider = this.providers.get(providerName);
    const providerTxs = await provider.listTransactions(date);
    const ledger = await this.ledgerSide(date, provider.name);
    const { matched, mismatches } = compare(providerTxs, ledger);
    const report: ReconciliationReport = {
      provider: provider.name,
      date,
      generatedAt: new Date().toISOString(),
      summary: { providerTransactions: providerTxs.length, ledgerEntries: ledger.length, matched, mismatches: mismatches.length },
      mismatches,
    };
    await this.db.query(
      `INSERT INTO reconciliation_reports (provider, date, report) VALUES ($1,$2,$3)
       ON CONFLICT (provider, date) DO UPDATE SET report = EXCLUDED.report, created_at = now()`,
      [provider.name, date, JSON.stringify(report)],
    );
    return report;
  }

  /** Cash-moving ledger entries for the day, with the amount that hit the provider clearing account. */
  private async ledgerSide(date: string, provider: string): Promise<LedgerSide[]> {
    const r = await this.db.query<{ id: string; kind: string; external_ref: string; amount: number; currency: string }>(
      `SELECT e.id, e.kind, e.external_ref, a.currency, sum(abs(p.amount)) AS amount
         FROM journal_entries e
         JOIN postings p ON p.entry_id = e.id
         JOIN accounts a ON a.id = p.account_id AND a.code LIKE 'platform:clearing:%'
         LEFT JOIN payments pa ON pa.id = e.payment_id
         LEFT JOIN payouts po ON po.id = e.payout_id
        WHERE e.kind IN ('capture','refund','payout_settled')
          AND e.external_ref IS NOT NULL
          AND (e.created_at AT TIME ZONE 'UTC')::date = $1::date
          AND COALESCE(pa.provider, po.provider) = $2
        GROUP BY e.id, e.kind, e.external_ref, a.currency`,
      [date, provider],
    );
    return r.rows.map((row) => ({
      entryId: row.id,
      kind: KIND_MAP[row.kind],
      ref: row.external_ref,
      amount: row.amount,
      currency: row.currency.trim(),
    }));
  }
}
