import { createServer } from 'node:http';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PROBE_QUEUE } from '@resolvehub/contracts';
import type { Readiness } from '@resolvehub/contracts';
import { parseWorkerEnv } from './env.js';
import { processProbe } from './probe.js';

async function bootstrap(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
  });
  connection.on('error', () => console.warn('Worker Redis connection interrupted'));
  const worker = new Worker(
    PROBE_QUEUE,
    (job) => Promise.resolve(processProbe(job.name, job.data)),
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      // No domain jobs are registered before durable failure handling exists.
      removeOnComplete: { count: 100, age: 3_600 },
      removeOnFail: { count: 100, age: 86_400 },
    },
  );
  worker.on('error', () => console.warn('Worker queue connection interrupted'));
  worker.on('failed', () => console.warn('System probe failed'));

  const healthConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
  });
  healthConnection.on('error', () => console.warn('Worker health connection interrupted'));

  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end(JSON.stringify({ code: 'METHOD_NOT_ALLOWED' }));
      return;
    }
    if (request.url === '/health/live') {
      response.end(JSON.stringify({ service: 'worker', status: 'alive' }));
      return;
    }
    if (request.url !== '/health/ready') {
      response.writeHead(404).end(JSON.stringify({ code: 'NOT_FOUND' }));
      return;
    }
    void healthConnection
      .ping()
      .then((reply) => {
        const redis = reply === 'PONG' ? 'up' : 'down';
        const consumer = worker.isRunning() ? 'up' : 'down';
        const ready = redis === 'up' && consumer === 'up';
        const body: Readiness = {
          service: 'worker',
          status: ready ? 'ready' : 'not_ready',
          checks: { redis, consumer },
        };
        response.writeHead(ready ? 200 : 503).end(JSON.stringify(body));
      })
      .catch(() => {
        const body: Readiness = {
          service: 'worker',
          status: 'not_ready',
          checks: { redis: 'down', consumer: worker.isRunning() ? 'up' : 'down' },
        };
        response.writeHead(503).end(JSON.stringify(body));
      });
  });

  const shutdown = () => {
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    server.close();
    void worker
      .close()
      .then(() => {
        connection.disconnect();
        healthConnection.disconnect();
        clearTimeout(timeout);
      })
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.WORKER_PORT, env.WORKER_HOST, resolve);
  });
  console.info(`ResolveHub worker health at http://${env.WORKER_HOST}:${env.WORKER_PORT}`);
}

bootstrap().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.message.startsWith('Invalid worker environment:')
      ? error.message
      : 'Worker startup failed. Check configuration and port availability.',
  );
  process.exit(1);
});
