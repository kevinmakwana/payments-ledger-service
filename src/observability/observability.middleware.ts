import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { newContext, runWithContext } from './request-context';

const logger = new Logger('Http');
/** Probes poll constantly; logging them would drown real traffic. They are still counted in the metrics. */
const QUIET = /^\/(health|metrics)(\/|$)/;

/**
 * First middleware in the chain: starts the request context (request id + trace), echoes `X-Request-Id`, and on
 * completion records the HTTP metrics and one access-log line. Only the method, the route PATTERN, the status and
 * the duration are recorded: never the query string, headers or body (they can hold secrets and card data), and
 * never raw ids in metric labels (unbounded cardinality).
 */
export function observabilityMiddleware(metrics: MetricsService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = newContext(req.headers);
    res.setHeader('X-Request-Id', ctx.requestId);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = typeof req.route?.path === 'string' ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      metrics.httpDuration.observe({ method: req.method, route }, seconds);
      if (QUIET.test(req.path)) return;
      runWithContext(ctx, () =>
        logger.log({ msg: 'http_request', method: req.method, route, status: res.statusCode, durationMs: Math.round(seconds * 1000) }),
      );
    });
    runWithContext(ctx, next);
  };
}
