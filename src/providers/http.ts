import { ProviderTimeoutError } from '../common/errors';
import { traceHeaders } from '../observability/request-context';
import { SpanKind, withSpan } from '../observability/spans';

/** Hard stop for paginated listings, so a misbehaving API can never loop forever (or silently truncate). */
export const MAX_LIST_PAGES = 500;

/** A non-negative integer amount, or undefined when the field is absent, null or malformed (never guess a fee). */
export const minorUnits = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

export interface ProviderResponse {
  ok: boolean;
  status: number;
  json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * One provider HTTP call with a deadline covering the connection, the headers AND the body.
 * Provider calls run inside DB transactions (row locks, pooled connections), so an unbounded
 * wait here would stall the whole service.
 */
export async function providerRequest(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ProviderResponse> {
  const { pathname } = new URL(url); // path only: the query string and body can hold ids and card data
  const method = init.method ?? 'GET';
  return withSpan(
    `${provider} ${method} ${pathname}`,
    { kind: SpanKind.CLIENT, attributes: { 'app.provider': provider, 'http.request.method': method, 'url.path': pathname } },
    async (span) => {
      const res = await send(provider, url, init, timeoutMs);
      span.setAttribute('http.response.status_code', res.status);
      return res;
    },
  );
}

async function send(provider: string, url: string, init: RequestInit, timeoutMs: number): Promise<ProviderResponse> {
  try {
    // Continue the caller's W3C trace (if any) so a provider-side log line can be tied back to our request.
    const headers = { ...(init.headers as Record<string, string> | undefined), ...traceHeaders() };
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    const json = (await res.json()) as ProviderResponse['json'];
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    // DOMException is not always `instanceof Error` (e.g. across realms), so match on the name.
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderTimeoutError(provider, timeoutMs);
    }
    throw err;
  }
}
