import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { newContext, runWithContext } from './request-context';
import { context, markFailed, propagation, SpanKind, spanIds, trace } from './spans';

const logger = new Logger('Http');
const tracer = trace.getTracer('payments-ledger-service');
/** Probes poll constantly; logging them would drown real traffic. They are still counted in the metrics. */
const QUIET = /^\/(health|metrics)(\/|$)/;

/**
 * First middleware in the chain: starts the request context (request id + trace), echoes `X-Request-Id`, and on
 * completion records the HTTP metrics and one access-log line. With OpenTelemetry on it also opens the SERVER span
 * (continuing an inbound `traceparent`) that every span created while handling the request hangs off. Only the method, the route PATTERN, the status and
 * the duration are recorded: never the query string, headers or body (they can hold secrets and card data), and
 * never raw ids in metric labels (unbounded cardinality).
 */
export function observabilityMiddleware(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Probes poll constantly: no span for them (their metrics are still recorded).
    const traced = !QUIET.test(req.path);
    const parent = propagation.extract(context.active(), req.headers);
    const span = traced ? tracer.startSpan(req.method, { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method } }, parent) : undefined;
    const requestContext = span ? trace.setSpan(parent, span) : parent;
    const ctx = newContext(req.headers, span && spanIds(span));
    res.setHeader('X-Request-Id', ctx.requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      if (span) {
        span.updateName(`${req.method} ${route}`);
        span.setAttributes({ 'http.route': route, 'http.response.status_code': res.statusCode, 'app.request_id': ctx.requestId });
        if (res.statusCode >= 500) markFailed(span, `HTTP ${res.statusCode}`);
        span.end();
      }
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.httpDuration.observe({ method: req.method, route }, seconds);
      if (QUIET.test(req.path)) return;
      runWithContext(ctx, () =>
        logger.log({ msg: 'http_request', method: req.method, route, status: res.statusCode, durationMs: Math.round(seconds * 1000) }),
      );
    });
    context.with(requestContext, () => runWithContext(ctx, next));
  };
}
