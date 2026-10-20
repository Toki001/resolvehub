import { createHash } from 'node:crypto';

export const SYNTHETIC_MODEL = 'resolvehub-synthetic-sha256-v1';
export const SYNTHETIC_DIMENSIONS = 64;
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
}
// Repeatable numeric test vectors. This adapter makes no semantic recall claim.
export function syntheticEmbedding(text: string) {
  const values = Array.from(
    { length: SYNTHETIC_DIMENSIONS },
    (_, i) =>
      createHash('sha256').update(`${SYNTHETIC_MODEL}:${text}:${i}`).digest().readUInt16BE(0) /
        32767.5 -
      1,
  );
  const norm = Math.hypot(...values);
  return values.map((value) => Number((value / norm).toFixed(8)));
}
export class SyntheticEmbeddingProvider implements EmbeddingProvider {
  readonly model = SYNTHETIC_MODEL;
  readonly dimensions = SYNTHETIC_DIMENSIONS;
  async embed(texts: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    if (texts.length < 1 || texts.length > 16 || texts.some((text) => text.length > 1000))
      throw new Error('Invalid embedding batch');
    return texts.map(syntheticEmbedding);
  }
}
