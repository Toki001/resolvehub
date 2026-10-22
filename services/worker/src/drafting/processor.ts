import { observe, count, trace, validTraceparent } from '@resolvehub/telemetry';
import { DraftingFailure } from '@resolvehub/ai';
import type { DraftingProgress, DraftingStage } from '@resolvehub/ai';
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

export interface DraftDiagnostic {
  event: 'draft.completed' | 'draft.failed';
  requestId: string;
  jobId: string;
  traceId: string | null;
  stage: DraftingStage;
  category: string | null;
  attempt: number;
  maxAttempts: number;
  outcome: 'answer' | 'insufficient_evidence' | 'failed';
}
export function draftProcessor(dependencies: {
  pool: ReturnType<typeof createDatabase>['pool'];
  pipeline: Pick<DraftingPipeline, 'run'>;
  signal?: AbortSignal;
  retryBaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  report?: (diagnostic: DraftDiagnostic) => void;
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
    const maxAttempts = dependencies.maxAttempts ?? 4;
    let stage: DraftingStage = 'source';
    const move: DraftingProgress = async (next) => {
      stage = next;
      try {
        await session.checkpoint(next);
      } catch {
        throw new DraftingFailure('DRAFT_PERSISTENCE_FAILED', 'persistence');
      }
    };
    const report = (
      event: DraftDiagnostic['event'],
      category: string | null,
      outcome: DraftDiagnostic['outcome'],
    ) => {
      const activeTraceId = trace.getActiveSpan()?.spanContext().traceId ?? '';
      const storedTraceId = validTraceparent(session.job.traceparent)
        ? (session.job.traceparent.split('-')[1] ?? '')
        : '';
      const traceId =
        /^[a-f0-9]{32}$/.test(activeTraceId) && !/^0+$/.test(activeTraceId)
          ? activeTraceId
          : storedTraceId;
      const diagnostic: DraftDiagnostic = {
        event,
        requestId: session.job.requestId,
        jobId: session.job.id,
        traceId: /^[a-f0-9]{32}$/.test(traceId) && !/^0+$/.test(traceId) ? traceId : null,
        stage,
        category,
        attempt: session.attemptNumber,
        maxAttempts,
        outcome,
      };
      try {
        (dependencies.report ?? ((value) => console.info(JSON.stringify(value))))(diagnostic);
      } catch {
        /* Logging never retries or changes a completed transaction. */
      }
    };
    try {
      const claim = await session.claim(maxAttempts);
      if (claim === 'skip') return;
      observe(
        'queue_wait_duration_seconds',
        Math.max(
          0,
          Date.now() - Math.max(session.job.createdAt.getTime(), session.job.availableAt.getTime()),
        ) / 1000,
        { job_kind: 'draft_response' },
      );
      if (claim === 'exhausted') throw new IngestionFailure('WORKER_INTERRUPTED');
      await move('source');
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
            move,
          ),
        dependencies.timeoutMs ?? 10000,
        dependencies.signal ?? new AbortController().signal,
        'PROVIDER_TIMEOUT',
      );
      await move('persistence');
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
      stage = 'complete';
      const validationCategory =
        result.generation.abstentionReason === 'invalid_citations'
          ? 'RAG_CITATION_VALIDATION_FAILED'
          : result.generation.abstentionReason === 'invalid_generation'
            ? 'GEMINI_INVALID_RESPONSE'
            : null;
      report('draft.completed', validationCategory, result.generation.outcome);
      count('drafts_completed', 1, { outcome: result.generation.outcome });
      observe('draft_cost_usd', result.generation.estimatedCostUsd);
      observe('draft_duration_seconds', (Date.now() - session.job.createdAt.getTime()) / 1000);
    } catch (error) {
      if (error instanceof DraftingFailure) stage = error.stage;
      const classified = classify(error);
      const failure =
          classified.category === 'DEPENDENCY_UNAVAILABLE'
            ? new IngestionFailure(
                stage === 'persistence' ? 'DRAFT_PERSISTENCE_FAILED' : 'DRAFT_WORKER_FAILED',
              )
            : classified,
        delay = retryDelay(
          session.attemptNumber,
          dependencies.retryBaseMs ?? 1000,
          Math.random,
          failure.retryAfterMs,
        );
      const terminal = await session.fail(
        failure.category,
        failure.permanent || session.attemptNumber >= maxAttempts,
        delay,
        failure.replayEligible,
        stage,
      );
      report('draft.failed', failure.category, 'failed');
      count(terminal ? 'queue_dead_letter_events' : 'queue_retries', 1, {
        job_kind: 'draft_response',
      });
      if (terminal) throw new UnrecoverableError(failure.category);
      throw new RetryIngestion(delay);
    } finally {
      await session.close();
    }
  };
}
