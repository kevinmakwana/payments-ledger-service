import { currentContext, newContext, parseTraceparent, runWithContext, sanitizeRequestId, traceHeaders } from './request-context';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('parseTraceparent (W3C trace context)', () => {
  it('extracts the trace and parent span ids from a valid header', () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({ traceId: TRACE, parentSpanId: SPAN });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['too few parts', `00-${TRACE}-${SPAN}`],
    ['short trace id', `00-abc-${SPAN}-01`],
    ['non-hex trace id', `00-${'z'.repeat(32)}-${SPAN}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${SPAN}-01`],
    ['all-zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['forbidden version ff', `ff-${TRACE}-${SPAN}-01`],
    ['uppercase hex (spec requires lowercase)', `00-${TRACE.toUpperCase()}-${SPAN}-01`],
  ])('rejects %s', (_label, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });
});

describe('sanitizeRequestId', () => {
  it('accepts reasonable ids and rejects anything that could pollute logs or headers', () => {
    expect(sanitizeRequestId('req-123_ABC.4')).toBe('req-123_ABC.4');
    expect(sanitizeRequestId('x'.repeat(64))).toBe('x'.repeat(64));
    for (const bad of [undefined, '', 'x'.repeat(65), 'has space', 'new\nline', 'quote"', '<script>']) {
      expect(sanitizeRequestId(bad)).toBeUndefined();
    }
  });
});

describe('newContext', () => {
  it('echoes a valid inbound request id and continues an inbound trace with a fresh span', () => {
    const ctx = newContext({ 'x-request-id': 'abc-1', traceparent: `00-${TRACE}-${SPAN}-01` });
    expect(ctx.requestId).toBe('abc-1');
    expect(ctx.traceId).toBe(TRACE);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.spanId).not.toBe(SPAN);
  });

  it('generates ids when nothing valid is supplied', () => {
    const ctx = newContext({ 'x-request-id': 'bad id', traceparent: 'nonsense' });
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(newContext({}).requestId).not.toBe(ctx.requestId);
  });
});

describe('request context propagation', () => {
  it('is visible to async work started inside runWithContext, and gone outside', async () => {
    const ctx = newContext({});
    expect(currentContext()).toBeUndefined();
    await runWithContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentContext()).toBe(ctx);
    });
    expect(currentContext()).toBeUndefined();
  });

  it('produces an outgoing traceparent on the same trace with a new span, or nothing without a context', () => {
    expect(traceHeaders()).toEqual({});
    const ctx = newContext({ traceparent: `00-${TRACE}-${SPAN}-01` });
    runWithContext(ctx, () => {
      const { traceparent } = traceHeaders();
      expect(traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
      expect(traceparent).not.toContain(SPAN);
    });
  });
});
