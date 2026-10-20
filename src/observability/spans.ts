import { Attributes, context, propagation, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Thin wrapper over the OpenTelemetry API. Without a registered SDK (tracing off, or any unit test) every call here
 * is a no-op, so call sites never need to check whether tracing is enabled.
 */
const tracer = trace.getTracer('payments-ledger-service');

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
}

/** Runs `fn` inside a new child span of the active one; records a thrown error and always ends the span. */
export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { kind: options.kind ?? SpanKind.INTERNAL, attributes: options.attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      markFailed(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function markFailed(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : String(err));
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.name : 'error' });
}

/** The span's ids, or undefined for the no-op span of a process without an SDK. */
export function spanIds(span: Span): { traceId: string; spanId: string } | undefined {
  const sc = span.spanContext();
  return trace.isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : undefined;
}

/** W3C headers for the active span (including the sampled flag); empty when no OpenTelemetry trace is active. */
export function injectTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export { SpanKind, SpanStatusCode, context, propagation, trace };
