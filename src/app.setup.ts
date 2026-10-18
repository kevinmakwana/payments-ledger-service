import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { loadConfig } from './config/config';

export function configureApp(app: NestExpressApplication): void {
  const config = loadConfig();
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy); // so rate limits see the real client IP
  // CSP is off: this is a JSON API, and Swagger UI at /docs relies on inline scripts a default CSP would block.
  app.use(helmet({ contentSecurityPolicy: false }));
  // Respects `rawBody: true`, so webhook signatures are still verified over the exact bytes received.
  app.useBodyParser('json', { limit: config.bodyLimit });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Payments & Ledger Service')
      .setDescription('Acme Market: buyers pay, sellers get paid out, the platform takes a fee.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .addSecurityRequirements('bearer')
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);
}
