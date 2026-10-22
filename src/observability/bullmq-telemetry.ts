import type { Context, SpanOptions } from '@opentelemetry/api';
import { SpanKind, context, trace } from '@opentelemetry/api';
import type { Span, Telemetry, Tracer } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';

/** Stands in for a span that is not recorded; it leaves the context untouched, so nothing nests under it. */
const NOT_RECORDED: Span = {
  setSpanOnContext: (ctx) => ctx,
  setAttribute: () => undefined,
  setAttributes: () => undefined,
  addEvent: () => undefined,
  recordException: () => undefined,
  end: () => undefined,
};

/**
 * BullMQ also traces its own upkeep (`getNextJob`, `extendLocks`, `moveStalledJobsToWait`, `startStalledCheckTimer`,
 * `close`, ...). Those run outside any request or job, so each one would be exported as a root span of a trace of
 * its own: a steady stream of one-span traces that says nothing about payments. An INTERNAL span with no active
 * span around it is exactly that; INTERNAL spans inside a job or request (`complete`, `failed`, ...) are kept, as
 * are PRODUCER and CONSUMER spans (`add <queue>`, `process <queue>`), which carry the trace across the queue.
 */
export function isQueueUpkeep(kind: SpanKind | undefined, active: Context): boolean {
  return kind === SpanKind.INTERNAL && !trace.getSpan(active);
}

export function createBullMQTelemetry(tracerName: string): Telemetry {
  const inner = new BullMQOtel({ tracerName });
  const tracer: Tracer = {
    startSpan(name: string, options?: SpanOptions, ctx?: Context) {
      const parent = ctx ?? context.active();
      return isQueueUpkeep(options?.kind, parent) ? NOT_RECORDED : inner.tracer.startSpan(name, options, ctx);
    },
  };
  return { tracer, contextManager: inner.contextManager, meter: inner.meter };
}
