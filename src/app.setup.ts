import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Payments & Ledger Service')
      .setDescription('Acme Market: buyers pay, sellers get paid out, the platform takes a fee.')
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);
}
