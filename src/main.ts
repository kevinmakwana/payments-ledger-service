import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config/config';
import { SimulatedProvider } from './providers/simulated.provider';

async function bootstrap() {
  // rawBody is required: webhook HMACs are computed over the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  app.enableShutdownHooks();
  const { port } = loadConfig();
  await app.listen(port);
  // The simulated provider delivers its signed webhooks back to this very server.
  app.get(SimulatedProvider).setBaseUrl(`http://127.0.0.1:${port}`);
  new Logger('Bootstrap').log(`Listening on :${port}  (OpenAPI docs at /docs)`);
}

void bootstrap();
