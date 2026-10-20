import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import { AppModule } from './app.module.js';
import { parseApiEnv } from './env.js';
import { ApiExceptionFilter } from './error.filter.js';
import type { ApiRequest } from './auth/context.js';

async function bootstrap(): Promise<void> {
  const env = parseApiEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  app.use(helmet());
  app.use((request: ApiRequest, response: Response, next: NextFunction) => {
    const candidate = z.uuid().safeParse(request.headers['x-request-id']);
    request.requestId = candidate.success ? candidate.data.toLowerCase() : randomUUID();
    response.setHeader('X-Request-ID', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({
    origin: env.WEB_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'Location', 'Retry-After'],
  });
  app.useBodyParser('json', { limit: '64kb' });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, env.API_HOST);
  console.info(`ResolveHub API listening at http://${env.API_HOST}:${env.API_PORT}`);
}

bootstrap().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.message.startsWith('Invalid API environment:')
      ? error.message
      : 'API startup failed. Check configuration and port availability.',
  );
  process.exit(1);
});
