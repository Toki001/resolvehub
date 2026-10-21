import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  DraftingPipeline,
  ExtractiveMockProvider,
  OllamaDraftProvider,
  SyntheticEmbeddingProvider,
} from '@resolvehub/ai';
import type { GenerationProvider, DraftConfig } from '@resolvehub/ai';
import { KnowledgeRepository } from '@resolvehub/db';
import type { createDatabase } from '@resolvehub/db';
import { draftProcessor } from './processor.js';
import { ingestionBackoff, ingestionOptions } from '../ingestion/runtime.js';
import { ProviderLimiter } from '../ingestion/limiter.js';
import type { WorkerEnv } from '../env.js';

export const DRAFT_QUEUE = 'resolvehub-support-drafting-v1';
export function createDraftRuntime(
  env: WorkerEnv,
  pool: ReturnType<typeof createDatabase>['pool'],
  config: DraftConfig,
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
    connection.on('error', () => console.warn('Draft Redis connection interrupted'));
  const queue = new Queue(DRAFT_QUEUE, {
    connection: producer,
    prefix: env.INGESTION_QUEUE_PREFIX,
    defaultJobOptions: ingestionOptions,
  });
  queue.on('error', () => console.warn('Draft queue interrupted'));
  const delegate =
    config.provider === 'mock' ? new ExtractiveMockProvider() : new OllamaDraftProvider(config);
  const limiter = new ProviderLimiter(
    producer,
    `${env.INGESTION_QUEUE_PREFIX}:draft:${delegate.name}:${delegate.model}`,
    env.DRAFT_REQUESTS_PER_SECOND,
  );
  const provider: GenerationProvider = {
    name: delegate.name,
    model: delegate.model,
    generate: async (input, signal) => {
      await limiter.acquire(signal);
      return delegate.generate(input, signal);
    },
  };
  const pipeline = new DraftingPipeline(
    new SyntheticEmbeddingProvider(),
    provider,
    {
      search: (organizationId, question, embedding, first) =>
        new KnowledgeRepository(pool, organizationId).search(question, embedding, first),
    },
    config,
  );
  const controller = new AbortController();
  const process = draftProcessor({
    pool,
    pipeline,
    signal: controller.signal,
    timeoutMs: config.timeoutMs + 1000,
  });
  const worker = new Worker(DRAFT_QUEUE, (job) => process(job.data), {
    connection: consumer,
    prefix: env.INGESTION_QUEUE_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
    settings: { backoffStrategy: ingestionBackoff },
  });
  worker.on('error', () => console.warn('Draft consumer interrupted'));
  worker.on('failed', () => console.warn('Draft attempt failed; inspect durable job state'));
  let stopped = false,
    lastDispatch = 0,
    pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      await queue.setGlobalConcurrency(env.WORKER_CONCURRENCY);
      const jobs = await pool.query<{ job_id: string; organization_id: string }>(
        'SELECT * FROM drafting_dispatch_candidates()',
      );
      for (const row of jobs.rows) {
        const id = `draft-${row.organization_id}-${row.job_id}`,
          existing = await queue.getJob(id);
        if (existing && ['completed', 'failed'].includes(await existing.getState()))
          await existing.remove();
        await queue.add(
          'draftSupportResponse',
          { organizationId: row.organization_id, jobId: row.job_id },
          { jobId: id },
        );
      }
      lastDispatch = Date.now();
    })()
      .catch(() => console.warn('Draft handoff delayed; durable records retained'))
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 500);
  timer.unref();
  tick();
  return {
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
    },
  };
}
