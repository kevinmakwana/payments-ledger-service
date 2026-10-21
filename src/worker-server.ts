import type { INestApplicationContext } from '@nestjs/common';
import { createServer, type Server, type ServerResponse } from 'http';
import { ApiKeyService } from './auth/api-key.service';
import { extractToken } from './auth/api-keys';
import type { AppConfig } from './config/config';
import { HealthService } from './health/health.service';
import { MetricsService } from './observability/metrics.service';

const send = (res: ServerResponse, status: number, body: unknown, contentType = 'application/json') => {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/**
 * The worker tier has no HTTP API, but orchestrators still need to probe it and Prometheus needs its metrics
 * (provider calls made by the payout and recovery workers are only visible here). Routes: /health/live,
 * /health/ready, and /metrics (admin key required when API_KEYS is set). Keep this port internal.
 */
export async function startWorkerServer(app: INestApplicationContext, config: AppConfig): Promise<Server> {
  const health = app.get(HealthService, { strict: false });
  const metrics = app.get(MetricsService, { strict: false });
  const keys = app.get(ApiKeyService, { strict: false });
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      try {
        if (path === '/health/live') return send(res, 200, { status: 'ok' });
        if (path === '/health/ready' || path === '/health') {
          const { ok, checks } = await health.readiness();
          return send(res, ok ? 200 : 503, { status: ok ? 'ok' : 'unavailable', checks });
        }
        if (path === '/metrics') {
          if (keys.enabled) {
            const principal = await keys.authenticate(extractToken(req.headers));
            if (!principal) return send(res, 401, { statusCode: 401, code: 'unauthorized', message: 'A valid API key is required' });
            if (principal.role !== 'admin') return send(res, 403, { statusCode: 403, code: 'forbidden', message: 'This endpoint requires an admin API key' });
          }
          return send(res, 200, await metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
        }
        return send(res, 404, { statusCode: 404, code: 'not_found', message: 'Not found' });
      } catch {
        return send(res, 500, { statusCode: 500, code: 'internal_error', message: 'Internal server error' });
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(config.workerHealthPort, resolve));
  return server;
}
