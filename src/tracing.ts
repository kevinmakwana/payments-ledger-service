import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { tracingEnabled } from './config/config';

let sdk: NodeSDK | undefined;

/**
 * OpenTelemetry bootstrap. `instrument.ts` starts it and `main.ts` imports that FIRST, so the pg instrumentation can
 * patch the driver before any other module loads it. It is configured with the standard OTEL_* variables and is
 * completely off unless an OTLP endpoint is set, so a plain `npm run start:dev` or a test run pays nothing.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT          e.g. http://otel-collector:4318   (turns tracing on)
 *   OTEL_SERVICE_NAME                    default payments-ledger-service
 *   OTEL_TRACES_SAMPLER / _ARG           e.g. parentbased_traceidratio / 0.1
 *   OTEL_SDK_DISABLED=true               hard off switch
 */
export function startTracing(env: NodeJS.ProcessEnv = process.env): boolean {
  if (sdk || !tracingEnabled(env)) return Boolean(sdk);
  // Metrics are served by Prometheus (/metrics) and logs go to stdout: only spans are exported from here.
  env.OTEL_METRICS_EXPORTER ??= 'none';
  env.OTEL_LOGS_EXPORTER ??= 'none';
  env.OTEL_SERVICE_NAME ??= 'payments-ledger-service';
  sdk = new NodeSDK({
    // Statement text is recorded, bind parameters are not (enhancedDatabaseReporting stays off): they hold card refs and amounts.
    instrumentations: [new PgInstrumentation()],
  });
  sdk.start();
  return true;
}

/**
 * Flushes buffered spans and stops the exporter. Safe to call when tracing was never started. An unreachable
 * collector must never break shutdown (or the process exit that follows), so a failed final flush is only logged.
 */
export async function shutdownTracing(): Promise<void> {
  const running = sdk;
  sdk = undefined;
  try {
    await running?.shutdown();
  } catch (err) {
    process.stderr.write(`tracing: final span flush failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
