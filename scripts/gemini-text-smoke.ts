import { mkdir, writeFile } from 'node:fs/promises';
import { Redis } from 'ioredis';
import { z } from 'zod';
import {
  GEMINI_MODEL,
  GeminiDraftProvider,
  GeminiFailure,
  geminiEligibility,
  parseGeminiConfig,
  parseDraftConfig,
} from '@resolvehub/ai';
import { RedisGeminiBudget } from '../services/worker/src/drafting/gemini-budget.js';

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  model: GEMINI_MODEL,
  status: 'not_run',
  requests: 0,
  infrastructureCostUsd: null,
};
let redis: Redis | undefined;
try {
  if (
    !process.argv.includes('--live') ||
    process.env.GEMINI_LIVE_SMOKE_ENABLED !== 'true' ||
    process.env.CI ||
    process.env.GITHUB_ACTIONS
  )
    throw new GeminiFailure('LIVE_SMOKE_EXPLICIT_OPT_IN_REQUIRED');
  const access = parseGeminiConfig(process.env);
  const eligibility = geminiEligibility(access);
  if (eligibility) throw new GeminiFailure(eligibility);
  const organizationId = '60000000-0000-4000-8000-000000000001';
  const url = new URL(process.env.REDIS_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname))
    throw new GeminiFailure('LIVE_SMOKE_LOCAL_REDIS_REQUIRED');
  redis = new Redis(url.href, {
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
  const config = parseDraftConfig(process.env);
  const start = performance.now();
  const result = await new GeminiDraftProvider(access, config, budget, (url, init) => {
    report.requests = Number(report.requests) + 1;
    if (report.requests !== 1) throw new GeminiFailure('LIVE_SMOKE_REQUEST_LIMIT');
    return fetch(url, init).then(async (response) => {
      report.httpStatus = response.status;
      if (!response.ok && Number(response.headers.get('content-length')) <= 65536) {
        // Never retain raw error text. Only fixed diagnostic categories escape.
        const reader = response.clone().body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (reader) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 65536) break;
            chunks.push(next.value);
          }
          if (size <= 65536) {
            const parsed = z
              .object({
                error: z.object({
                  status: z
                    .enum([
                      'INVALID_ARGUMENT',
                      'NOT_FOUND',
                      'PERMISSION_DENIED',
                      'RESOURCE_EXHAUSTED',
                      'UNAUTHENTICATED',
                      'FAILED_PRECONDITION',
                    ])
                    .optional(),
                  message: z.string().optional(),
                }),
              })
              .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (parsed.success) {
              report.providerErrorStatus = parsed.data.error.status;
              report.invalidParameter =
                [
                  'temperature',
                  'thinking',
                  'candidate',
                  'schema',
                  'token',
                  'key',
                  'quota',
                  'billing',
                  'mime',
                  'format',
                  'payload',
                ].find((word) => parsed.data.error.message?.toLowerCase().includes(word)) ?? null;
            }
          }
        } catch {
          /* Unknown provider details remain private. */
        } finally {
          await reader?.cancel();
        }
      }
      return response;
    });
  }).generate(
    {
      organizationId,
      prompt:
        'Synthetic connection test. Return JSON {"kind":"insufficient_evidence","claims":[]}.',
      question: 'Synthetic connection test.',
      evidence: [],
      maxOutputTokens: 64,
    },
    AbortSignal.timeout(config.timeoutMs),
  );
  z.object({
    kind: z.literal('insufficient_evidence'),
    claims: z.array(z.never()).length(0),
  }).parse(result.output);
  Object.assign(report, {
    status: 'passed',
    latencyMs: performance.now() - start,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    tokenCountSource: result.tokenCountSource,
    estimatedFreeApiCostUsd: 0,
  });
} catch (error) {
  report.status = 'failed';
  report.reasonCode =
    error instanceof GeminiFailure ? error.category : 'LIVE_SMOKE_DEPENDENCY_FAILURE';
  process.exitCode = 1;
} finally {
  redis?.disconnect();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/gemini-text-smoke.json', JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.info(JSON.stringify(report, null, 2));
}
