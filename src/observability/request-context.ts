import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes, randomUUID } from 'crypto';

export interface RequestContext {
  /** Correlates every log line, error response and outgoing call of one request. */
  requestId: string;
  /** W3C trace id (32 hex). Continues an inbound `traceparent`, otherwise starts a new trace. */
  traceId: string;
  /** This service's span in the trace (16 hex). */
  spanId: string;
}

const als = new AsyncLocalStorage<RequestContext>();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** `00-<32 hex trace id>-<16 hex parent span id>-<2 hex flags>`, lowercase, no all-zero ids, version != ff. */
export function parseTraceparent(header: string | undefined): { traceId: string; parentSpanId: string } | undefined {
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header ?? '');
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]) || /^0+$/.test(m[3])) return undefined;
  return { traceId: m[2], parentSpanId: m[3] };
}

/** Inbound request ids end up in logs and response headers: accept only a conservative character set and length. */
export function sanitizeRequestId(raw: string | undefined): string | undefined {
  return raw !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : undefined;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function newContext(headers: Record<string, string | string[] | undefined>): RequestContext {
  const trace = parseTraceparent(first(headers['traceparent']));
  return {
    requestId: sanitizeRequestId(first(headers['x-request-id'])) ?? randomUUID(),
    traceId: trace?.traceId ?? hex(16),
    spanId: hex(8),
  };
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return als.getStore();
}

/** Headers for an outgoing call: continues the current trace with a new span. Empty outside a request. */
export function traceHeaders(): Record<string, string> {
  const ctx = currentContext();
  return ctx ? { traceparent: `00-${ctx.traceId}-${hex(8)}-01` } : {};
}
