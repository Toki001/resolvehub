import { parseDraftConfig } from '@resolvehub/ai';
import { createDraftRuntime } from './drafting/runtime.js';
import { createServer } from 'node:http';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PROBE_QUEUE } from '@resolvehub/contracts';
import type { Readiness } from '@resolvehub/contracts';
import { parseWorkerEnv } from './env.js';
import { processProbe } from './probe.js';
import {
  createDatabase,
  CONTRACT_MIGRATION,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from '@resolvehub/db';
import { createIngestionRuntime } from './ingestion/runtime.js';

async function bootstrap(): Promise<void> {
  const env = parseWorkerEnv(process.env);
  const draftConfig = parseDraftConfig(process.env);
  const database = createDatabase(env.DATABASE_URL, {
    maxConnections: env.WORKER_CONCURRENCY * 2 + 4,
  });
  database.pool.on('error', () => console.warn('Worker database connection interrupted'));
  const ingestion = createIngestionRuntime(
    env,
    database.pool,
    new URL(
      import.meta.url.endsWith('.ts') ? './ingestion/pdf-parser.ts' : './ingestion/pdf-parser.js',
      import.meta.url,
    ),
  );
  const drafting = createDraftRuntime(env, database.pool, draftConfig);
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
    void Promise.allSettled([
      healthConnection.ping().then((reply) => {
        if (reply !== 'PONG') throw new Error('Redis not ready');
      }),
      database.pool
        .query(
          'SELECT 1 FROM schema_migrations WHERE name=$1 AND EXISTS(SELECT 1 FROM embedding_configuration WHERE model=$2 AND dimensions=$3)',
          [CONTRACT_MIGRATION, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS],
        )
        .then((result) => {
          if (!result.rowCount) throw new Error('Database not ready');
        }),
      fetch(new URL('/minio/health/ready', env.S3_ENDPOINT), {
        signal: AbortSignal.timeout(2000),
      }).then((result) => {
        if (!result.ok) throw new Error('Storage not ready');
      }),
    ]).then((results) => {
      const checks = {
        redis: results[0]?.status === 'fulfilled' ? ('up' as const) : ('down' as const),
        postgres: results[1]?.status === 'fulfilled' ? ('up' as const) : ('down' as const),
        storage: results[2]?.status === 'fulfilled' ? ('up' as const) : ('down' as const),
        consumer:
          worker.isRunning() && ingestion.ready() && drafting.ready()
            ? ('up' as const)
            : ('down' as const),
      };
      const ready = Object.values(checks).every((status) => status === 'up');
      const body: Readiness = { service: 'worker', status: ready ? 'ready' : 'not_ready', checks };
      response.writeHead(ready ? 200 : 503).end(JSON.stringify(body));
    });
  });

  const shutdown = () => {
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    server.close();
    void worker
      .close()
      .then(() => ingestion.close())
      .then(() => drafting.close())
      .then(() => database.pool.end())
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
    error instanceof Error &&
      (error.message.startsWith('Invalid worker environment:') ||
        error.message.startsWith('Invalid draft configuration:'))
      ? error.message
      : 'Worker startup failed. Check configuration and port availability.',
  );
  process.exit(1);
});
