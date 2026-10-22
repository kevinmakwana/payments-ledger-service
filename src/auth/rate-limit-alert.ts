import type { Alert } from '../alerts/alert.service';

/**
 * What to do each time the Redis rate-limit store could not be used and a request was counted in memory instead:
 * bump the counter every time, but raise an alert only when none was raised in the last `intervalMs`. An outage
 * means a fallback per request, so alerting on each would flood the channel; the alert carries how many requests
 * were affected since the previous one, and the counter metric keeps the exact total.
 */
export function rateLimitFallbackReporter(options: {
  count: () => void;
  raise: (alert: Alert) => Promise<void>;
  intervalMs?: number;
  now?: () => number;
}): (err: unknown) => void {
  const { count, raise, intervalMs = 10 * 60_000, now = Date.now } = options;
  let lastAlertAt: number | undefined;
  let sinceLastAlert = 0;
  return (err) => {
    count();
    sinceLastAlert++;
    const at = now();
    if (lastAlertAt !== undefined && at - lastAlertAt < intervalMs) return;
    lastAlertAt = at;
    const requests = sinceLastAlert;
    sinceLastAlert = 0;
    void raise({
      kind: 'rate_limit_store_unavailable',
      severity: 'warning',
      message: 'The Redis rate-limit store is unavailable; requests are limited per instance in memory until it recovers',
      details: { requestsCountedInMemory: requests, error: err instanceof Error ? err.message : String(err) },
    }).catch(() => undefined);
  };
}
