import { Inject, Injectable } from '@nestjs/common';
import { Alert, AlertService } from '../alerts/alert.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DbService } from '../db/db.service';
import { LedgerService } from '../ledger/ledger.service';

/** Periodic self-checks that nothing else would notice: a growing dead-letter queue and ledger drift. */
@Injectable()
export class MonitorService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly alerts: AlertService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs every check, raises an alert for each problem found and returns them. */
  async run(): Promise<Alert[]> {
    const raised: Alert[] = [];

    const threshold = this.config.alertDlqThreshold;
    const dead = await this.db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'dead'");
    const deadLetters = dead.rows[0].n;
    if (threshold > 0 && deadLetters >= threshold) {
      raised.push({
        kind: 'webhook_dlq_depth',
        severity: 'warning',
        message: `${deadLetters} webhook event(s) are dead-lettered and need a manual retry`,
        details: { deadLetters, threshold },
      });
    }

    const tb = await this.ledger.trialBalance();
    if (!tb.balanced) {
      const inconsistentAccounts = tb.accounts.filter((a) => !a.cacheConsistent).map((a) => a.code);
      const unbalancedCurrencies = tb.currencyTotals.filter((c) => c.total !== 0);
      raised.push({
        kind: 'ledger_drift',
        severity: 'critical',
        message: 'Ledger is inconsistent: cached balances disagree with postings, or postings do not sum to zero',
        details: { inconsistentAccounts, unbalancedCurrencies },
      });
    }

    for (const alert of raised) await this.alerts.raise(alert);
    return raised;
  }
}
