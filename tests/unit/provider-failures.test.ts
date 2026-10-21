import {
  EmbeddingProviderError,
  MockDraftProvider,
  SyntheticEmbeddingProvider,
} from '@resolvehub/ai';
import {
  bounded,
  classify,
  IngestionFailure,
  sleep,
} from '../../services/worker/src/ingestion/failure.js';

test.each([429, 500, 503, 400, 401])(
  'provider HTTP %i has bounded safe retry metadata',
  (status) => {
    const failure = classify(new EmbeddingProviderError(status, 60000));
    expect(failure.retryAfterMs).toBe(30000);
    expect(failure.category).toBe(
      status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_UNAVAILABLE',
    );
    expect(failure.permanent).toBe(status >= 400 && status < 500 && status !== 429);
    expect(failure.message).not.toContain('password');
  },
);
test('provider retry hints reject negative or non-finite waits', () => {
  expect(new EmbeddingProviderError(500, -10).retryAfterMs).toBe(0);
  expect(new EmbeddingProviderError(500, NaN).retryAfterMs).toBe(0);
  expect(new EmbeddingProviderError(500).retryAfterMs).toBe(0);
});
test('unknown failures stay transient and typed failures retain their identity', () => {
  const known = new IngestionFailure('INVALID_TYPE', true);
  expect(classify(known)).toBe(known);
  expect(classify('secret')).toMatchObject({
    category: 'DEPENDENCY_UNAVAILABLE',
    permanent: false,
  });
});
test('bounded work and backoff respect preexisting and mid-flight cancellation', async () => {
  const stopped = new AbortController();
  stopped.abort();
  await expect(bounded(async () => 'unused', 100, stopped.signal)).rejects.toMatchObject({
    category: 'WORKER_INTERRUPTED',
  });
  await expect(sleep(100, stopped.signal)).rejects.toMatchObject({
    category: 'WORKER_INTERRUPTED',
  });
  const active = new AbortController();
  const waiting = sleep(1000, active.signal);
  active.abort();
  await expect(waiting).rejects.toMatchObject({ category: 'WORKER_INTERRUPTED' });
  const working = new AbortController();
  const result = bounded(async () => new Promise<string>(() => undefined), 1000, working.signal);
  working.abort();
  await expect(result).rejects.toMatchObject({ category: 'WORKER_INTERRUPTED' });
});
test('mock AI abstains, rejects malformed embedding batches and observes cancellation', async () => {
  const provider = new SyntheticEmbeddingProvider();
  for (const texts of [[], Array(17).fill('text'), ['x'.repeat(1001)]])
    await expect(provider.embed(texts, new AbortController().signal)).rejects.toThrow(
      'Invalid embedding batch',
    );
  const controller = new AbortController();
  controller.abort();
  await expect(provider.embed(['text'], controller.signal)).rejects.toThrow();
  expect(
    await new MockDraftProvider().draft({
      organizationId: 'synthetic',
      question: 'Unverified?',
      evidence: [],
    }),
  ).toMatchObject({ kind: 'insufficient_evidence', citations: [], provider: 'mock' });
});
