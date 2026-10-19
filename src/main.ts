import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig, loadConfig } from './config/config';
import { AppLogger } from './observability/app-logger';
import { SimulatedProvider } from './providers/simulated.provider';
import { startWorkerServer } from './worker-server';

/** Structured JSON lines for log pipelines (production default); Nest's coloured console otherwise. */
function loggerFor(config: AppConfig) {
  return config.logFormat === 'json' ? new AppLogger(undefined, config.logLevel === 'verbose' ? 'verbose' : config.logLevel) : undefined;
}

/** `worker` role: no HTTP API, just the queue workers and schedulers, plus a small probe/metrics server. */
async function bootstrapWorker(config: AppConfig) {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: loggerFor(config) });
  app.enableShutdownHooks();
  if (config.simulatedWebhookBaseUrl) app.get(SimulatedProvider).setBaseUrl(config.simulatedWebhookBaseUrl);
  const server = await startWorkerServer(app, config);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close());
  logger.log(`Worker running; health and metrics on :${config.workerHealthPort}`);
}

async function bootstrapHttp(config: AppConfig) {
  // rawBody is required: webhook HMACs are computed over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: loggerFor(config) });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port);
  // The simulated provider delivers its signed webhooks back to this API (override when the API is behind a gateway
  // or the workers run in a separate process).
  app.get(SimulatedProvider).setBaseUrl(config.simulatedWebhookBaseUrl ?? `http://127.0.0.1:${config.port}`);
  new Logger('Bootstrap').log(`Listening on :${config.port} as role "${config.role}"  (OpenAPI docs at /docs)`);
}

async function bootstrap() {
  const config = loadConfig();
  await (config.role === 'worker' ? bootstrapWorker(config) : bootstrapHttp(config));
}

void bootstrap();
