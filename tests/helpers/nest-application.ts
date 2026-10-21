import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../services/api/src/app.module.js';
import { API_ENV, parseApiEnv } from '../../services/api/src/env.js';
import { configureApplication } from '../../services/api/src/configure.js';

// These suites exercise the real Nest guards/controllers/resolvers/filter and DB.
// Only configuration is overridden; domain providers and authorization stay real.
if (/\/(support|health|ingestion-http)\.test\.ts$/.test(expect.getState().testPath ?? '')) {
  const env = parseApiEnv(process.env);
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(API_ENV)
    .useValue(env)
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    rawBody: true,
    logger: false,
  });
  configureApplication(app, env);
  try {
    await app.listen(0, '127.0.0.1');
    process.env.API_URL = await app.getUrl();
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${process.env.API_URL}/health/ready`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Nest test application did not become ready');
  } catch (error) {
    await app.close();
    throw error;
  }
  afterAll(async () => {
    await app.close();
  });
}
