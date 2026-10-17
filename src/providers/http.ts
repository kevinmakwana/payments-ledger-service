import { ProviderTimeoutError } from '../common/errors';

/** Hard stop for paginated listings, so a misbehaving API can never loop forever (or silently truncate). */
export const MAX_LIST_PAGES = 500;

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
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
