import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { parseApiEnv } from './env.js';
import { configureApplication } from './configure.js';

async function bootstrap(): Promise<void> {
  const env = parseApiEnv(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  configureApplication(app, env);
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
