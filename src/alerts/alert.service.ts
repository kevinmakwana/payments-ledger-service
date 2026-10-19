import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig, APP_CONFIG } from '../config/config';
import { MetricsService } from '../observability/metrics.service';
import { traceHeaders } from '../observability/request-context';

export interface Alert {
  kind: string;
  severity: 'warning' | 'critical';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Operational alerts: always logged as one structured error line (so log-based alerting works
 * out of the box) and, when ALERT_WEBHOOK_URL is set, POSTed as JSON. Raising an alert must
 * never break or stall the job that raised it, so delivery failures are logged and swallowed.
 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async raise(alert: Alert): Promise<void> {
    const payload = { service: 'payments-ledger-service', at: new Date().toISOString(), ...alert };
    this.logger.error(`ALERT ${JSON.stringify(payload)}`);
    this.metrics?.alertsRaised.inc({ kind: alert.kind, severity: alert.severity });
    const url = this.config.alertWebhookUrl;
    if (!url) return;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...traceHeaders() },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.alertTimeoutMs),
      });
      if (!res.ok) this.logger.error(`Alert webhook answered ${res.status} for ${alert.kind}`);
    } catch (err) {
      this.logger.error(`Could not deliver alert ${alert.kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
