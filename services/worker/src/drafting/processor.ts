import { UnrecoverableError } from 'bullmq';
import { DraftSession } from '@resolvehub/db';
import type { createDatabase } from '@resolvehub/db';
import type { DraftingPipeline } from '@resolvehub/ai';
import { ingestionJobSchema } from '@resolvehub/contracts';
import {
  bounded,
  classify,
  IngestionFailure,
  RetryIngestion,
  retryDelay,
} from '../ingestion/failure.js';

export function draftProcessor(dependencies: {
  pool: ReturnType<typeof createDatabase>['pool'];
  pipeline: Pick<DraftingPipeline, 'run'>;
  signal?: AbortSignal;
  retryBaseMs?: number;
  timeoutMs?: number;
}) {
  return async (input: unknown) => {
    const envelope = ingestionJobSchema.safeParse(input);
    if (!envelope.success) throw new UnrecoverableError('Invalid draft envelope');
    const session = await DraftSession.open(
      dependencies.pool,
      envelope.data.organizationId,
      envelope.data.jobId,
    );
    if (!session) return;
    try {
      const claim = await session.claim();
      if (claim === 'skip') return;
      if (claim === 'exhausted') throw new IngestionFailure('WORKER_INTERRUPTED');
      const source = await session.source();
      if (!source) throw new IngestionFailure('RESOURCE_UNAVAILABLE', true);
      const previousUsage = await session.usage();
      const result = await bounded(
        (signal) =>
          dependencies.pipeline.run(
            {
              organizationId: session.job.organizationId,
              question: source.question,
              remainingBudgetUsd: Math.max(0, 0.02 - previousUsage.cost),
            },
            signal,
          ),
        dependencies.timeoutMs ?? 10000,
        dependencies.signal ?? new AbortController().signal,
        'PROVIDER_TIMEOUT',
      );
      const usage = await session.recordUsage(result.generation);
      result.generation = {
        ...result.generation,
        inputTokens: usage.input,
        outputTokens: usage.output,
        estimatedCostUsd: usage.cost,
        accountedAttempts: usage.accounted,
        usageIncomplete: usage.accounted < usage.attempts,
      };
      if (!(await session.complete({ ...result, ...result.generation }, source.question)))
        throw new IngestionFailure('EVIDENCE_CHANGED', true);
    } catch (error) {
      const failure = classify(error),
        delay = retryDelay(
          session.attemptNumber,
          dependencies.retryBaseMs ?? 1000,
          Math.random,
          failure.retryAfterMs,
        );
      if (await session.fail(failure.category, failure.permanent, delay))
        throw new UnrecoverableError(failure.category);
      throw new RetryIngestion(delay);
    } finally {
      await session.close();
    }
  };
}
