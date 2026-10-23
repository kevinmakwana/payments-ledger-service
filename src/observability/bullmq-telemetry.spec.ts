import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { createBullMQTelemetry, isQueueUpkeep } from './bullmq-telemetry';

const withActiveSpan = () => trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }));

describe('isQueueUpkeep', () => {
  it('flags an INTERNAL span with nothing around it (stalled checks, polling, lock renewal)', () => {
    expect(isQueueUpkeep(SpanKind.INTERNAL, ROOT_CONTEXT)).toBe(true);
  });

  it('keeps INTERNAL spans inside a request or job (complete, failed, ...)', () => {
    expect(isQueueUpkeep(SpanKind.INTERNAL, withActiveSpan())).toBe(false);
  });

  it('keeps PRODUCER and CONSUMER spans even without a parent: they start and carry the trace', () => {
    expect(isQueueUpkeep(SpanKind.PRODUCER, ROOT_CONTEXT)).toBe(false);
    expect(isQueueUpkeep(SpanKind.CONSUMER, ROOT_CONTEXT)).toBe(false);
  });
});

describe('createBullMQTelemetry', () => {
  it('hands BullMQ a span that records nothing and changes no context for upkeep', () => {
    const span = createBullMQTelemetry('test').tracer.startSpan('moveStalledJobsToWait q', { kind: SpanKind.INTERNAL }, ROOT_CONTEXT);
    expect(span.setSpanOnContext(ROOT_CONTEXT)).toBe(ROOT_CONTEXT);
    expect(() => {
      span.setAttributes({ a: 1 });
      span.recordException(new Error('x'));
      span.end();
    }).not.toThrow();
  });

  it('still exposes the context manager BullMQ uses to carry a trace through a job', () => {
    expect(createBullMQTelemetry('test').contextManager).toBeDefined();
  });
});
