import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { createDatabase, migrate, KnowledgeRepository } from '@resolvehub/db';
import {
  DraftingPipeline,
  SyntheticEmbeddingProvider,
  GeminiDraftProvider,
  GeminiFailure,
  geminiEligibility,
  parseGeminiConfig,
  parseDraftConfig,
} from '@resolvehub/ai';
import type { RagDraft } from '@resolvehub/ai';
import { RedisGeminiBudget } from '../services/worker/src/drafting/gemini-budget.js';
import {
  readEvaluationFixtures,
  loadEvaluationCorpus,
  evaluateResults,
} from '../packages/ai/evals/runner.js';

const report: Record<string, unknown> = {
  status: 'not_run',
  provider: 'gemini',
  model: 'gemini-2.5-flash-lite',
  embeddingModel: 'resolvehub-synthetic-sha256-v1',
  billing: 'manual verified Free Tier only',
  generatedAt: new Date().toISOString(),
  cloudRequests: 0,
  limitations: [
    'At most one cloud request per command. Descriptive synthetic subset, not a production quality or performance benchmark.',
    'Existing tenant-filtered hybrid retrieval; no Gemini embedding migration or external delivery.',
  ],
};
let container: StartedTestContainer | undefined, redis: Redis | undefined;
let pool: ReturnType<typeof createDatabase>['pool'] | undefined;
let calls = 0;
async function boundedErrorBody(response: Response): Promise<unknown> {
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) return null;
      buffers.push(chunk.value);
    }
    try {
      return JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } catch {
      return null;
    }
  } finally {
    await reader.cancel();
  }
}
try {
  if (
    !process.argv.includes('--live') ||
    process.env.GEMINI_LIVE_SMOKE_ENABLED !== 'true' ||
    process.env.CI ||
    process.env.GITHUB_ACTIONS
  )
    throw new GeminiFailure('LIVE_SMOKE_EXPLICIT_OPT_IN_REQUIRED');
  const access = parseGeminiConfig(process.env),
    eligibility = geminiEligibility(access);
  if (eligibility) throw new GeminiFailure(eligibility);
  const organizationId = '60000000-0000-4000-8000-000000000001';
  if (!access.organizations.includes(organizationId))
    throw new GeminiFailure('GEMINI_SYNTHETIC_SCOPE_REQUIRED');
  const redisUrl = new URL(process.env.REDIS_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(redisUrl.hostname))
    throw new GeminiFailure('LIVE_SMOKE_LOCAL_REDIS_REQUIRED');
  // Share the application's persistent request budget; never reset or flush it.
  redis = new Redis(redisUrl.href, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  redis.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    redis?.once('ready', resolve);
    redis?.once('error', () => reject(new GeminiFailure('GEMINI_UNAVAILABLE')));
  });
  const budget = new RedisGeminiBudget(
    redis,
    access,
    process.env.INGESTION_QUEUE_PREFIX ?? 'resolvehub',
  );
  const state = await budget.status();
  if (!state.canGenerate) throw new GeminiFailure(state.reasonCode ?? 'GEMINI_UNAVAILABLE');
  const config = parseDraftConfig({
    ...process.env,
    DRAFT_PROVIDER: 'gemini',
    DRAFT_MODEL: 'gemini-2.5-flash-lite',
  });
  const fixtures = await readEvaluationFixtures(),
    first = fixtures.cases[0];
  if (!first) throw new Error('Synthetic fixture missing');
  const original = first.organizationId;
  const corpus = fixtures.corpus.map((row) => ({
    ...row,
    organizationId: row.organizationId === original ? organizationId : row.organizationId,
  }));
  const selected = [
    ...fixtures.cases
      .filter((row) => row.organizationId === original && row.category === 'answerable')
      .slice(0, 1),
    ...fixtures.cases
      .filter((row) => row.organizationId === original && row.category === 'insufficient')
      .slice(0, 1),
    ...fixtures.cases
      .filter((row) => row.organizationId === original && row.category === 'adversarial')
      .slice(0, 1),
  ].map((row) => ({ ...row, organizationId }));
  if (selected.length !== 3) throw new Error('Expected three synthetic smoke cases');
  // Customer records and the developer database are never read. The temporary
  // database contains only the checked-in synthetic evaluation corpus.
  container = await new GenericContainer(
    'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d',
  )
    .withName(`resolvehub-gemini-smoke-${randomUUID()}`)
    .withEnvironment({
      POSTGRES_USER: 'smoke',
      POSTGRES_PASSWORD: 'synthetic-only',
      POSTGRES_DB: 'smoke',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .withStartupTimeout(90000)
    .start();
  pool = createDatabase(
    `postgresql://smoke:synthetic-only@${container.getHost()}:${container.getMappedPort(5432)}/smoke`,
  ).pool;
  await pool.query(
    'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto',
  );
  await migrate(pool, new URL('../packages/db/migrations/', import.meta.url));
  await loadEvaluationCorpus(pool, corpus);
  const database = pool;
  const pipeline = new DraftingPipeline(
    new SyntheticEmbeddingProvider(),
    new GeminiDraftProvider(access, config, budget, (url, options) => {
      if (++calls > 1) throw new GeminiFailure('LIVE_SMOKE_REQUEST_LIMIT');
      return fetch(url, options)
        .catch((error) => {
          const safe = z
            .object({
              cause: z.object({
                code: z.enum([
                  'ENOTFOUND',
                  'ECONNREFUSED',
                  'ETIMEDOUT',
                  'ECONNRESET',
                  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
                  'CERT_HAS_EXPIRED',
                ]),
              }),
            })
            .safeParse(error);
          if (safe.success) report.networkError = safe.data.cause.code;
          throw error;
        })
        .then(async (response) => {
          report.providerHttpStatus = response.status;
          if (!response.ok) {
            // Do not retain or print provider messages, keys, inputs or bodies.
            const body = await boundedErrorBody(response);
            const safe = z
              .object({
                error: z.object({
                  status: z
                    .enum([
                      'INVALID_ARGUMENT',
                      'FAILED_PRECONDITION',
                      'PERMISSION_DENIED',
                      'UNAUTHENTICATED',
                      'NOT_FOUND',
                      'RESOURCE_EXHAUSTED',
                      'UNAVAILABLE',
                      'DEADLINE_EXCEEDED',
                      'INTERNAL',
                    ])
                    .optional(),
                  details: z
                    .array(
                      z.object({
                        reason: z
                          .enum([
                            'API_KEY_INVALID',
                            'API_KEY_EXPIRED',
                            'API_KEY_SERVICE_BLOCKED',
                            'SERVICE_DISABLED',
                            'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
                            'API_KEY_HTTP_REFERRER_BLOCKED',
                          ])
                          .optional(),
                      }),
                    )
                    .optional(),
                }),
              })
              .safeParse(body);
            if (safe.success) {
              report.providerErrorStatus = safe.data.error.status;
              report.providerReason = safe.data.error.details?.flatMap((detail) =>
                detail.reason ? [detail.reason] : [],
              );
            }
          }
          return response;
        });
    }),
    {
      search: (org, question, embedding, first) =>
        new KnowledgeRepository(database, org).search(question, embedding, first),
    },
    config,
  );
  const results: RagDraft[] = [];
  try {
    for (const item of selected)
      results.push(await pipeline.run({ organizationId, question: item.question }));
  } finally {
    report.cloudRequests = calls;
    report.completedCases = results.map((row, index) => ({
      id: selected[index]?.id,
      outcome: row.generation.outcome,
      citations: row.citations.map((c) => ({
        documentId: c.documentId,
        versionId: c.versionId,
        chunkId: c.chunkId,
      })),
      inputTokens: row.generation.inputTokens,
      outputTokens: row.generation.outputTokens,
      latencyMs: row.generation.totalLatencyMs,
      estimatedFreeApiCostUsd: row.generation.estimatedCostUsd,
    }));
  }
  const metrics = evaluateResults(selected, corpus, results);
  Object.assign(report, {
    status: metrics.failures.length ? 'completed_with_failures' : 'passed',
    metrics,
    corpusDigest: fixtures.digest,
    tokenUsage: {
      input: results.reduce((sum, r) => sum + r.generation.inputTokens, 0),
      output: results.reduce((sum, r) => sum + r.generation.outputTokens, 0),
    },
    latencyMs: { max: Math.max(...results.map((row) => row.generation.totalLatencyMs)) },
    infrastructureCosts: 'Not measured; separate from free API access.',
  });
  if (metrics.failures.length) process.exitCode = 1;
} catch (error) {
  report.status = calls ? 'failed' : 'not_run';
  report.cloudRequests = calls;
  report.reasonCode =
    error instanceof GeminiFailure ? error.category : 'LIVE_SMOKE_DEPENDENCY_FAILURE';
  process.exitCode = 1;
} finally {
  redis?.disconnect();
  await pool?.end();
  await container?.stop();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/gemini-live-smoke.json', JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.info(JSON.stringify(report, null, 2));
}
