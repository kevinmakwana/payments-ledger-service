import { rateLimitFallbackReporter } from './rate-limit-alert';

describe('rateLimitFallbackReporter', () => {
  const setup = (intervalMs = 1000) => {
    let t = 10_000;
    const count = jest.fn();
    const raise = jest.fn().mockResolvedValue(undefined);
    const report = rateLimitFallbackReporter({ count, raise, intervalMs, now: () => t });
    return { count, raise, report, advance: (ms: number) => (t += ms) };
  };

  it('counts every fallback but alerts on the first one at once', () => {
    const { count, raise, report } = setup();
    report(new Error('Stream isn\'t writeable'));
    expect(count).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0][0]).toMatchObject({
      kind: 'rate_limit_store_unavailable',
      severity: 'warning',
      details: { requestsCountedInMemory: 1, error: 'Stream isn\'t writeable' },
    });
  });

  it('stays quiet during the interval, however many requests fall back', () => {
    const { count, raise, report, advance } = setup(1000);
    report(new Error('down'));
    for (let i = 0; i < 50; i++) {
      advance(10);
      report(new Error('down'));
    }
    expect(count).toHaveBeenCalledTimes(51);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('alerts again after the interval and reports how many requests were affected since the last alert', () => {
    const { raise, report, advance } = setup(1000);
    report('down');
    report('down');
    report('down');
    advance(1000);
    report('still down');
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise.mock.calls[1][0].details).toEqual({ requestsCountedInMemory: 3, error: 'still down' });
  });

  it('never throws into the request path when the alert cannot be delivered', async () => {
    const raise = jest.fn().mockRejectedValue(new Error('webhook down'));
    const report = rateLimitFallbackReporter({ count: () => undefined, raise });
    expect(() => report(new Error('x'))).not.toThrow();
    await Promise.resolve();
  });
});
