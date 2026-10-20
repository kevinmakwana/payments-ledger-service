import { loadConfig, tracingEnabled } from './config/config';
import { shutdownTracing, startTracing } from './tracing';

describe('tracing switch', () => {
  it.each([
    [{}, false],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, false],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, true],
    [{ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' }, true],
    [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' }, false],
  ])('%j -> enabled=%s', (env, enabled) => {
    expect(tracingEnabled(env)).toBe(enabled);
    expect(loadConfig(env).tracingEnabled).toBe(enabled);
  });

  it('does nothing when disabled: no SDK is started and shutdown is a safe no-op', async () => {
    expect(startTracing({})).toBe(false);
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
