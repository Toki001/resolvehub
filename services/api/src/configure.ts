import { beginHttp } from '@resolvehub/telemetry';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { ApiEnv } from './env.js';
import { ApiExceptionFilter } from './error.filter.js';
import type { ApiRequest } from './auth/context.js';

export function configureApplication(app: NestExpressApplication, env: ApiEnv): void {
  app.use((request: ApiRequest, response: Response, next: NextFunction) => {
    beginHttp(request.path, request.method, request.headers.traceparent, (_span, done) => {
      response.once('finish', () => done(response.statusCode));
      response.once('close', () => done(response.writableFinished ? response.statusCode : 499));
      next();
    });
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
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-ID',
      'traceparent',
      'X-Document-Type',
    ],
    exposedHeaders: ['X-Request-ID', 'Location', 'Retry-After'],
  });
  app.useBodyParser('raw', { type: 'application/octet-stream', limit: '10mb' });
  app.useBodyParser('json', { limit: '64kb' });
  app.useGlobalFilters(new ApiExceptionFilter());
}
