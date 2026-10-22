import { observed, traceContext, queueTraceMetadata, SpanKind } from '@resolvehub/telemetry';
import { jobTraceContext } from '@resolvehub/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  DraftingPipeline,
  ExtractiveMockProvider,
  OllamaDraftProvider,
  SyntheticEmbeddingProvider,
  GeminiDraftProvider,
  parseGeminiConfig,
} from '@resolvehub/ai';
import type { GenerationProvider, DraftConfig, GeminiConfig } from '@resolvehub/ai';
import { RedisGeminiBudget } from './gemini-budget.js';
import { KnowledgeRepository } from '@resolvehub/db';
import type { createDatabase } from '@resolvehub/db';
import { draftProcessor } from './processor.js';
import type { DraftDiagnostic } from './processor.js';
import { ingestionBackoff, ingestionOptions } from '../ingestion/runtime.js';
import { ProviderLimiter } from '../ingestion/limiter.js';
import type { WorkerEnv } from '../env.js';

export const DRAFT_QUEUE = 'resolvehub-support-drafting-v1';
export function createDraftRuntime(
  env: WorkerEnv,
  pool: ReturnType<typeof createDatabase>['pool'],
  config: DraftConfig,
  access: GeminiConfig = parseGeminiConfig({}),
  adapters: { geminiTransport?: typeof fetch; report?: (diagnostic: DraftDiagnostic) => void } = {},
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
  const budget = new RedisGeminiBudget(producer, access, env.INGESTION_QUEUE_PREFIX);
  const delegate =
    config.provider === 'mock'
      ? new ExtractiveMockProvider()
      : config.provider === 'gemini'
        ? new GeminiDraftProvider(access, config, budget, adapters.geminiTransport)
        : new OllamaDraftProvider(config);
  const limiter = new ProviderLimiter(
    producer,
    `${env.INGESTION_QUEUE_PREFIX}:draft:${delegate.name}:${delegate.model}`,
    env.DRAFT_REQUESTS_PER_SECOND,
  );
  const provider: GenerationProvider = {
    name: delegate.name,
    model: delegate.model,
    generate: async (input, signal) => {
      if (delegate.name !== 'gemini') await limiter.acquire(signal);
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
    maxAttempts: config.provider === 'gemini' ? access.maxAttempts : 4,
    ...(adapters.report ? { report: adapters.report } : {}),
  });
  const worker = new Worker(
    DRAFT_QUEUE,
    (job) =>
      observed(
        'queue.consume',
        { job_kind: 'draft_response' },
        () => process(job.data),
        traceContext(job.opts.telemetry?.metadata),
        SpanKind.CONSUMER,
      ),
    {
      connection: consumer,
      prefix: env.INGESTION_QUEUE_PREFIX,
      concurrency: env.WORKER_CONCURRENCY,
      settings: { backoffStrategy: ingestionBackoff },
    },
  );
  worker.on('error', () => console.warn('Draft consumer interrupted'));
  worker.on('failed', () => console.warn('Draft attempt failed; inspect durable job state'));
  let stopped = false,
    lastDispatch = 0,
    pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      await queue.setGlobalConcurrency(env.WORKER_CONCURRENCY);
      const status =
        config.provider === 'gemini'
          ? await budget.status()
          : {
              mode: config.provider === 'mock' ? 'synthetic' : 'unavailable',
              provider: config.provider,
              model: config.model,
              embeddingModel: 'resolvehub-synthetic-sha256-v1',
              canGenerate: true,
              freeTierVerified: false,
              reasonCode: null,
              message:
                config.provider === 'mock'
                  ? 'Synthetic offline provider. No cloud AI requests or API charges.'
                  : 'Local Ollama is configured; cloud provider status is unavailable.',
              retryAfterSeconds: null,
              lastSuccessfulAt: null,
            };
      await producer.set(
        `${env.INGESTION_QUEUE_PREFIX}:ai:status`,
        JSON.stringify({
          status,
          syntheticOrganizations: config.provider === 'gemini' ? access.organizations : [],
        }),
        'EX',
        5,
      );
      const jobs = await pool.query<{ job_id: string; organization_id: string }>(
        'SELECT * FROM drafting_dispatch_candidates()',
      );
      for (const row of jobs.rows) {
        const id = `draft-${row.organization_id}-${row.job_id}`,
          existing = await queue.getJob(id);
        if (existing && ['completed', 'failed'].includes(await existing.getState()))
          await existing.remove();
        const parent = await jobTraceContext(pool, row.organization_id, row.job_id);
        await observed(
          'queue.publish',
          { job_kind: 'draft_response' },
          () =>
            queue.add(
              'draftSupportResponse',
              { organizationId: row.organization_id, jobId: row.job_id },
              { jobId: id, telemetry: { metadata: queueTraceMetadata(), omitContext: true } },
            ),
          traceContext(parent),
          SpanKind.PRODUCER,
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
