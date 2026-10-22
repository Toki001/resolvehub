import { EmbeddingProviderError, GeminiFailure } from '@resolvehub/ai';

export class IngestionFailure extends Error {
  constructor(
    readonly category: string,
    readonly permanent = false,
    readonly retryAfterMs = 0,
    readonly replayEligible = !permanent,
  ) {
    super(category);
  }
}
export class RetryIngestion extends Error {
  constructor(readonly delayMs: number) {
    super('Ingestion attempt requires retry');
  }
}
export function retryDelay(attempt: number, base = 1000, random = Math.random, retryAfterMs = 0) {
  return Math.max(
    retryAfterMs,
    Math.floor(Math.min(30000, base * 2 ** Math.max(0, attempt - 1)) * (0.5 + random() * 0.5)),
  );
}
export function classify(error: unknown): IngestionFailure {
  if (error instanceof IngestionFailure) return error;
  if (error instanceof GeminiFailure)
    return new IngestionFailure(error.category, !error.transient, error.retryAfterMs, true);
  if (error instanceof EmbeddingProviderError) {
    if (error.status === 429)
      return new IngestionFailure('PROVIDER_RATE_LIMITED', false, error.retryAfterMs);
    return new IngestionFailure(
      'PROVIDER_UNAVAILABLE',
      error.status >= 400 && error.status < 500,
      error.retryAfterMs,
    );
  }
  return new IngestionFailure('DEPENDENCY_UNAVAILABLE');
}
export function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
  category = 'PROVIDER_TIMEOUT',
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      controller.abort();
      reject(new IngestionFailure(parent.aborted ? 'WORKER_INTERRUPTED' : category));
    };
    const timer = setTimeout(abort, timeoutMs);
    timer.unref();
    if (parent.aborted) {
      clearTimeout(timer);
      abort();
      return;
    }
    parent.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        parent.removeEventListener('abort', abort);
      })
      .catch(() => undefined);
  });
}
export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new IngestionFailure('WORKER_INTERRUPTED'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new IngestionFailure('WORKER_INTERRUPTED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
