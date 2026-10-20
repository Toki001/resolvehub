import { z } from 'zod';

// The only implemented embedding model is synthetic and has exactly 64 outputs.
// These constants describe migration 0003, rather than deriving DDL from env.
export const EMBEDDING_MODEL = 'resolvehub-synthetic-sha256-v1';
export const EMBEDDING_DIMENSIONS = 64;
const configuration = z.object({
  EMBEDDING_MODEL: z.literal(EMBEDDING_MODEL).default(EMBEDDING_MODEL),
  EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .pipe(z.literal(EMBEDDING_DIMENSIONS))
    .default(EMBEDDING_DIMENSIONS),
});
export function parseEmbeddingConfiguration(input: NodeJS.ProcessEnv) {
  const result = configuration.safeParse(input);
  if (!result.success)
    throw new Error('Invalid embedding configuration: EMBEDDING_MODEL, EMBEDDING_DIMENSIONS');
  return result.data;
}

export function validateVector(values: readonly number[]) {
  if (
    values.length !== EMBEDDING_DIMENSIONS ||
    values.some((v) => !Number.isFinite(v)) ||
    values.every((v) => v === 0)
  )
    throw new Error('Invalid embedding vector');
  return [...values];
}
