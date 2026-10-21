import { observed, observe, count, modelLabel } from '@resolvehub/telemetry';
import { tokenEstimate } from '@resolvehub/ai';
import type { EmbeddingProvider } from '@resolvehub/ai';
import { IngestionSession, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '@resolvehub/db';
import type { IngestionSource, createDatabase } from '@resolvehub/db';
import { ingestionJobSchema } from '@resolvehub/contracts';
import { UnrecoverableError } from 'bullmq';
import { bounded, classify, IngestionFailure, RetryIngestion, retryDelay } from './failure.js';
import { chunkText, extractText } from './extract.js';

interface Dependencies {
  pool: ReturnType<typeof createDatabase>['pool'];
  storage: {
    fetch(
      source: IngestionSource,
      organizationId: string,
      signal: AbortSignal,
    ): Promise<Uint8Array>;
  };
  provider: EmbeddingProvider;
  limiter: { acquire(signal: AbortSignal): Promise<void> };
  pdf: (bytes: Uint8Array, signal: AbortSignal) => Promise<string>;
  providerTimeoutMs?: number;
  attemptTimeoutMs?: number;
  retryBaseMs?: number;
  signal?: AbortSignal;
}
export function ingestionProcessor(dependencies: Dependencies) {
  if (
    dependencies.provider.model !== EMBEDDING_MODEL ||
    dependencies.provider.dimensions !== EMBEDDING_DIMENSIONS
  )
    throw new Error('Embedding configuration mismatch');
  return async (input: unknown) => {
    const parsed = ingestionJobSchema.safeParse(input);
    if (!parsed.success) throw new UnrecoverableError('Invalid ingestion envelope');
    const session = await IngestionSession.open(
      dependencies.pool,
      parsed.data.organizationId,
      parsed.data.jobId,
    );
    if (!session) return;
    const started = performance.now();
    const controller = new AbortController(),
      stop = () => controller.abort();
    if (dependencies.signal?.aborted) stop();
    dependencies.signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, dependencies.attemptTimeoutMs ?? 60000);
    timer.unref();
    try {
      const claim = await session.claim();
      if (claim === 'skip') return;
      observe(
        'queue_wait_duration_seconds',
        Math.max(
          0,
          Date.now() - Math.max(session.job.createdAt.getTime(), session.job.availableAt.getTime()),
        ) / 1000,
        { job_kind: 'document_ingestion' },
      );
      if (claim === 'exhausted') throw new IngestionFailure('WORKER_INTERRUPTED');
      const source = await session.source();
      if (!source) throw new IngestionFailure('RESOURCE_UNAVAILABLE', true);
      if (!source.authorized) throw new IngestionFailure('AUTHORIZATION_REVOKED', true);
      let text = await session.extraction();
      if (!text) {
        await session.stage('download');
        const bytes = await observed(
          'ingestion.download',
          { job_kind: 'document_ingestion', stage: 'download' },
          () =>
            bounded(
              (signal) => dependencies.storage.fetch(source, session.job.organizationId, signal),
              10000,
              controller.signal,
              'STORAGE_TIMEOUT',
            ),
        );
        await session.stage('extract');
        text = await observed(
          'ingestion.extract',
          { job_kind: 'document_ingestion', stage: 'extract' },
          () =>
            bounded(
              (signal) => extractText(bytes, source.mediaType, dependencies.pdf, signal),
              10000,
              controller.signal,
              'EXTRACTION_TIMEOUT',
            ),
        );
        await session.saveExtraction(text);
      }
      await session.stage('chunk');
      await observed('ingestion.chunk', { job_kind: 'document_ingestion', stage: 'chunk' }, () =>
        session.stageChunks(chunkText(text, source.versionId)),
      );
      await session.stage('embed');
      for (let batch = 0; batch < 16; batch++) {
        const rows = await session.pendingEmbeddings();
        if (!rows.length) break;
        await dependencies.limiter.acquire(controller.signal);
        const embeddings = await observed(
          'ingestion.embed',
          {
            job_kind: 'document_ingestion',
            stage: 'embed',
            model: modelLabel(dependencies.provider.model),
            provider: 'mock',
          },
          () =>
            bounded(
              (signal) =>
                dependencies.provider.embed(
                  rows.map((row) => row.text),
                  signal,
                ),
              dependencies.providerTimeoutMs ?? 5000,
              controller.signal,
            ),
        );
        count(
          'model_tokens',
          rows.reduce((total, row) => total + tokenEstimate(row.text), 0),
          {
            model: modelLabel(dependencies.provider.model),
            provider: 'mock',
            token_type: 'embedding',
          },
        );
        if (embeddings.length !== rows.length) throw new IngestionFailure('INVALID_EMBEDDING');
        await session.saveEmbeddings(
          rows.map((row, i) => {
            const embedding = embeddings[i];
            if (
              !embedding ||
              embedding.length !== EMBEDDING_DIMENSIONS ||
              embedding.some((n) => !Number.isFinite(n)) ||
              embedding.every((n) => n === 0)
            )
              throw new IngestionFailure('INVALID_EMBEDDING');
            return { id: row.id, embedding };
          }),
        );
      }
      if (controller.signal.aborted) throw new IngestionFailure('WORKER_INTERRUPTED');
      await session.stage('publish');
      await observed(
        'ingestion.publish',
        { job_kind: 'document_ingestion', stage: 'publish' },
        async () => {
          if (!(await session.complete())) throw new IngestionFailure('RESOURCE_SUPERSEDED', true);
        },
      );
      count('ingestion_completed', 1, { outcome: 'success' });
      observe('ingestion_duration_seconds', (performance.now() - started) / 1000);
    } catch (error) {
      const failure = classify(error),
        delayMs = retryDelay(
          session.attemptNumber,
          dependencies.retryBaseMs ?? 1000,
          Math.random,
          failure.retryAfterMs,
        );
      const terminal = await session.fail({
        category: failure.category,
        summary: `Ingestion could not complete: ${failure.category}.`,
        permanent: failure.permanent,
        replayEligible: !failure.permanent,
        delayMs,
      });
      count(terminal ? 'queue_dead_letter_events' : 'queue_retries', 1, {
        job_kind: 'document_ingestion',
      });
      if (terminal) throw new UnrecoverableError(failure.category);
      throw new RetryIngestion(delayMs);
    } finally {
      clearTimeout(timer);
      dependencies.signal?.removeEventListener('abort', stop);
      await session.close();
    }
  };
}
