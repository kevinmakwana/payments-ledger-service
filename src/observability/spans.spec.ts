import { context as otelContext, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { startFakeHttp, FakeHttp, respondJson } from '../../test/fake-http';
import { providerRequest } from '../providers/http';
import { newContext, runWithContext, traceHeaders } from './request-context';
import { SpanKind, SpanStatusCode, withSpan } from './spans';

const exporter = new InMemorySpanExporter();
const finished = () => exporter.getFinishedSpans();

beforeAll(() => {
  otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});
beforeEach(() => exporter.reset());
afterAll(() => {
  trace.disable();
  otelContext.disable();
  propagation.disable();
});

describe('withSpan', () => {
  it('returns the callback\'s value and ends a span carrying the name and attributes', async () => {
    const out = await withSpan('work', { attributes: { 'app.thing': 'x' } }, async () => 42);
    expect(out).toBe(42);
    expect(finished()).toHaveLength(1);
    expect(finished()[0]).toMatchObject({ name: 'work', kind: SpanKind.INTERNAL, attributes: { 'app.thing': 'x' } });
    expect(finished()[0].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('nests: a span started inside another is its child, in the same trace', async () => {
    await withSpan('outer', {}, () => withSpan('inner', {}, async () => undefined));
    const [inner, outer] = finished();
    expect(inner.name).toBe('inner');
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it('records the error, marks the span failed, ends it, and rethrows the original error', async () => {
    const boom = new Error('provider exploded');
    await expect(withSpan('call', {}, async () => { throw boom; })).rejects.toBe(boom);
    const [span] = finished();
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'Error' });
    expect(span.events.find((e) => e.name === 'exception')?.attributes).toMatchObject({ 'exception.message': 'provider exploded' });
  });
});

describe('providerRequest span', () => {
  let fake: FakeHttp | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it('is a CLIENT span named after provider, method and path only (never the query string), with the status code', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 402, { error: { type: 'card_error' } }));
    await providerRequest('stripe', `${fake.url}/v1/charges?customer=cus_secret`, { method: 'POST' }, 5000);
    const [span] = finished();
    expect(span.name).toBe('stripe POST /v1/charges');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toMatchObject({ 'app.provider': 'stripe', 'url.path': '/v1/charges', 'http.response.status_code': 402 });
    expect(JSON.stringify(span.attributes)).not.toContain('cus_secret');
  });

  it('sends a traceparent identifying the client span, so the provider-side trace continues from it', async () => {
    fake = await startFakeHttp((_req, res) => respondJson(res, 200, {}));
    await providerRequest('stripe', `${fake.url}/v1/x`, {}, 5000);
    const sent = fake.requests[0].headers['traceparent'] as string;
    const sc = finished()[0].spanContext();
    expect(sent).toBe(`00-${sc.traceId}-${sc.spanId}-01`);
  });

  it('marks the span failed when the request times out', async () => {
    fake = await startFakeHttp(() => undefined);
    await expect(providerRequest('stripe', `${fake.url}/v1/x`, {}, 100)).rejects.toMatchObject({ name: 'ProviderTimeoutError' });
    expect(finished()[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('request context ids', () => {
  it('uses the span\'s ids when tracing is on, so log lines match the exported trace', () => {
    const ctx = newContext({ traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }, { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) });
    expect(ctx).toMatchObject({ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) });
  });

  it('without a span, still continues an inbound traceparent (tracing off)', () => {
    expect(newContext({ traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }).traceId).toBe('a'.repeat(32));
  });

  it('outgoing headers fall back to the request context when no OpenTelemetry span is active', () => {
    const ctx = newContext({});
    expect(runWithContext(ctx, traceHeaders).traceparent).toMatch(new RegExp(`^00-${ctx.traceId}-[0-9a-f]{16}-01$`));
  });
});
