import { startFakeHttp, FakeHttp, respondJson } from './fake-http';
import { startTracing } from '../src/tracing';
import { describeE2E, key, newPayment, resetDb, startApp, TestApp } from './helpers';

interface ExportedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  status?: { code?: number };
  attributes: { key: string; value: Record<string, unknown> }[];
}

const attr = (s: ExportedSpan, k: string) => Object.values(s.attributes.find((a) => a.key === k)?.value ?? {})[0];

describeE2E('OpenTelemetry export (e2e, against a fake OTLP collector)', () => {
  let collector: FakeHttp;
  let t: TestApp;
  let spans: ExportedSpan[];
  const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const CALLER_SPAN = 'b7ad6b7169203331';

  beforeAll(async () => {
    collector = await startFakeHttp((_req, res) => respondJson(res, 200, {}));
    Object.assign(process.env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_BSP_SCHEDULE_DELAY: '100',
      OTEL_SERVICE_NAME: 'ledger-under-test',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    });
    expect(startTracing()).toBe(true);
    t = await startApp();
    await resetDb(t.db);

    const res = await t.call('POST', '/payments', newPayment({ capture: true }), { 'idempotency-key': key(), traceparent: `00-${TRACE_ID}-${CALLER_SPAN}-01` });
    expect(res.status).toBe(201);
    await t.drain();
    await t.close(); // app shutdown flushes the batch span processor
    spans = collector.requests
      .filter((r) => r.url === '/v1/traces')
      .flatMap((r) => JSON.parse(r.body).resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans))) as ExportedSpan[];
  });

  afterAll(async () => {
    for (const k of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_BSP_SCHEDULE_DELAY', 'OTEL_SERVICE_NAME', 'OTEL_METRICS_EXPORTER', 'OTEL_LOGS_EXPORTER']) delete process.env[k];
    await collector.close();
  });

  it('exports spans over OTLP/HTTP tagged with the configured service name', () => {
    const body = JSON.parse(collector.requests.find((r) => r.url === '/v1/traces')!.body);
    const service = body.resourceSpans[0].resource.attributes.find((a: any) => a.key === 'service.name');
    expect(service.value.stringValue).toBe('ledger-under-test');
  });

  it('continues the caller\'s trace: the server span is a child of the inbound traceparent', () => {
    const server = spans.find((s) => s.name === 'POST /payments');
    expect(server).toBeDefined();
    expect(server).toMatchObject({ traceId: TRACE_ID, parentSpanId: CALLER_SPAN, kind: 2 });
    expect(attr(server!, 'http.route')).toBe('/payments');
    expect(attr(server!, 'http.response.status_code')).toBe(201);
  });

  it('puts the provider operation and the DB transactions in that same trace', () => {
    const inTrace = spans.filter((s) => s.traceId === TRACE_ID).map((s) => s.name);
    expect(inTrace).toEqual(expect.arrayContaining(['provider_operation authorize', 'provider_operation capture']));
    expect(inTrace).toContain('db.transaction');
  });

  it('does not export spans for health and metrics probes', async () => {
    expect(spans.some((s) => /health|metrics/.test(s.name))).toBe(false);
  });

  it('carries the trace through the queue: the worker\'s job span belongs to the request that enqueued it', () => {
    const hook = spans.find((s) => s.name === 'POST /webhooks/:provider');
    expect(hook).toBeDefined();
    const sameTrace = spans.filter((s) => s.traceId === hook!.traceId).map((s) => s.name);
    expect(sameTrace).toEqual(expect.arrayContaining(['add webhooks.process', 'process webhooks']));
  });
});
