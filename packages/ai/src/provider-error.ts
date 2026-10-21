// Provider adapters expose safe status metadata, never raw response bodies/keys.
export class EmbeddingProviderError extends Error {
  readonly retryAfterMs: number;
  constructor(
    readonly status: number,
    retryAfterMs = 0,
  ) {
    super('Embedding provider request failed');
    this.retryAfterMs = Number.isFinite(retryAfterMs)
      ? Math.max(0, Math.min(30000, retryAfterMs))
      : 0;
  }
}
