import { RequestContext } from './request-context';

export interface LogInput {
  level: 'info' | 'warn' | 'error' | 'debug' | 'verbose' | 'fatal';
  message: unknown;
  context?: string;
  stack?: string;
  ctx?: RequestContext;
  /** Extra structured fields (status, durationMs, ...). They can never overwrite the core fields. */
  fields?: Record<string, unknown>;
  now?: Date;
}

/** One JSON object per line: easy to ship to any log pipeline, and every line of a request carries its ids. */
export function formatLogLine(input: LogInput): string {
  const core: Record<string, unknown> = {
    ts: (input.now ?? new Date()).toISOString(),
    level: input.level,
    ...(input.context ? { context: input.context } : {}),
    msg: input.message,
    ...(input.ctx ? { requestId: input.ctx.requestId, traceId: input.ctx.traceId } : {}),
    ...(input.stack ? { stack: input.stack } : {}),
  };
  return JSON.stringify({ ...input.fields, ...core });
}
