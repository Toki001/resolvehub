import { observed, traceContext, queueTraceMetadata, SpanKind } from '@resolvehub/telemetry';
import { jobTraceContext } from '@resolvehub/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';
import { SyntheticEmbeddingProvider } from '@resolvehub/ai';
import { INGESTION_QUEUE, ingestionJobSchema } from '@resolvehub/contracts';
import type { createDatabase } from '@resolvehub/db';
import { ingestionProcessor } from './processor.js';
import { DocumentStorage } from './storage.js';
import { ProviderLimiter } from './limiter.js';
import { pdfExtractor } from './extract.js';
import { RetryIngestion } from './failure.js';
import type { WorkerEnv } from '../env.js';

export const ingestionBackoff = (
  _attempt: number,
  _type: string | undefined,
  error: Error | undefined,
) => (error instanceof RetryIngestion ? error.delayMs : 1000);
export const ingestionOptions = {
  attempts: 4,
  backoff: { type: 'exponential-jitter', delay: 1000 },
  removeOnComplete: { count: 1000, age: 86400 },
  removeOnFail: { count: 1000, age: 604800 },
};
export function ingestionQueue(connection: Redis, prefix = 'resolvehub') {
  return new Queue(INGESTION_QUEUE, { connection, prefix, defaultJobOptions: ingestionOptions });
}
export async function dispatchIngestions(
  pool: ReturnType<typeof createDatabase>['pool'],
  queue: Queue,
) {
  const pending = await pool.query<{ job_id: string; organization_id: string }>(
    'SELECT * FROM ingestion_dispatch_candidates()',
  );
  for (const row of pending.rows) {
    const data = ingestionJobSchema.parse({
      jobId: row.job_id,
      organizationId: row.organization_id,
    });
    const id = `ingest-${data.organizationId}-${data.jobId}`;
    const existing = await queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove();
    }
    const parent = await jobTraceContext(pool, data.organizationId, data.jobId);
    await observed(
      'queue.publish',
      { job_kind: 'document_ingestion' },
      () =>
        queue.add('indexDocument', data, {
          jobId: id,
          telemetry: { metadata: queueTraceMetadata(), omitContext: true },
        }),
      traceContext(parent),
      SpanKind.PRODUCER,
    );

    // Delivery and this acknowledgement need not be atomic: queue identity and
    // the version lock make a repeated handoff harmless.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('resolvehub.organization_id',$1,true)", [
        data.organizationId,
      ]);
      await client.query(
        "UPDATE job_runs SET dispatch_after=now()+interval '5 seconds' WHERE organization_id=$1 AND id=$2 AND status='accepted'",
        [data.organizationId, data.jobId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
export function createIngestionRuntime(
  env: WorkerEnv,
  pool: ReturnType<typeof createDatabase>['pool'],
  pdfUrl: URL,
) {
  const producer = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 2500,
  });
  const consumer = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  for (const connection of [producer, consumer])
    connection.on('error', () => console.warn('Ingestion Redis connection interrupted'));
  const queue = ingestionQueue(producer, env.INGESTION_QUEUE_PREFIX);
  queue.on('error', () => console.warn('Ingestion dispatch connection interrupted'));
  const controller = new AbortController();
  const provider = new SyntheticEmbeddingProvider();
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  const process = ingestionProcessor({
    pool,
    provider,
    storage: new DocumentStorage(s3, env.S3_BUCKET),
    limiter: new ProviderLimiter(
      producer,
      `${env.INGESTION_QUEUE_PREFIX}:provider:${provider.model}`,
      env.EMBEDDING_REQUESTS_PER_SECOND,
    ),
    pdf: pdfExtractor(pdfUrl),
    providerTimeoutMs: env.EMBEDDING_TIMEOUT_MS,
    attemptTimeoutMs: env.INGESTION_ATTEMPT_TIMEOUT_MS,
    signal: controller.signal,
  });
  const worker = new Worker(
    INGESTION_QUEUE,
    (job) =>
      observed(
        'queue.consume',
        { job_kind: 'document_ingestion' },
        () => process(job.data),
        traceContext(job.opts.telemetry?.metadata),
        SpanKind.CONSUMER,
      ),
    {
      connection: consumer,
      prefix: env.INGESTION_QUEUE_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
      lockDuration: 30000,
      maxStalledCount: 1,
      settings: {
        backoffStrategy: ingestionBackoff,
      },
    },
  );
  worker.on('error', () => console.warn('Ingestion consumer connection interrupted'));
  worker.on('failed', () => console.warn('Ingestion attempt failed; inspect durable job status'));
  let stopped = false,
    lastDispatch = 0,
    pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      await queue.setGlobalConcurrency(env.WORKER_CONCURRENCY);
      await dispatchIngestions(pool, queue);
      lastDispatch = Date.now();
    })()
      .catch(() => console.warn('Ingestion handoff delayed; durable records retained'))
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 500);
  timer.unref();
  tick();
  return {
    worker,
    ready: () => worker.isRunning() && Date.now() - lastDispatch < 30000,
    async close() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
      await pending;
      await worker.close();
      await queue.close();
      producer.disconnect();
      consumer.disconnect();
      s3.destroy();
    },
  };
}
