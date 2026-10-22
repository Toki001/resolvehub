import { z } from 'zod';
import { parseEmbeddingConfiguration } from '@resolvehub/db';

const schema = z.object({
  DRAFT_PROVIDER: z.enum(['mock', 'ollama', 'gemini']).default('mock'),
  INGESTION_QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]{1,60}$/)
    .default('resolvehub'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_SECRET_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:/.test(url)),
  REDIS_URL: z.url().refine((url) => /^rediss?:/.test(url)),
  S3_BUCKET: z.string().min(1).default('resolvehub'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_ENDPOINT: z.url().refine((url) => /^https?:/.test(url)),
  WEB_ORIGIN: z.url().refine((url) => new URL(url).origin === url),
});

export type ApiEnv = z.infer<typeof schema>;
export const API_ENV = Symbol('API_ENV');

export function parseApiEnv(input: NodeJS.ProcessEnv): ApiEnv {
  const result = schema.safeParse({
    ...input,
    S3_ACCESS_KEY_ID: input.S3_ACCESS_KEY_ID ?? input.MINIO_ROOT_USER,
    S3_SECRET_ACCESS_KEY: input.S3_SECRET_ACCESS_KEY ?? input.MINIO_ROOT_PASSWORD,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid API environment: ${fields.join(', ')}`);
  }
  try {
    parseEmbeddingConfiguration(input);
  } catch {
    throw new Error('Invalid API environment: EMBEDDING_MODEL, EMBEDDING_DIMENSIONS');
  }
  return result.data;
}
