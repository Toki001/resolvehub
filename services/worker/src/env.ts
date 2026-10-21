import { z } from 'zod';
import { parseEmbeddingConfiguration } from '@resolvehub/db';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.url().refine((url) => /^rediss?:/.test(url)),
  DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:/.test(url)),
  S3_ENDPOINT: z.url().refine((url) => /^https?:/.test(url)),
  S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('resolvehub'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  WORKER_HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  EMBEDDING_REQUESTS_PER_SECOND: z.coerce.number().int().min(1).max(100).default(10),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  INGESTION_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(60000),
  INGESTION_QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9_-]{1,60}$/)
    .default('resolvehub'),
  DRAFT_REQUESTS_PER_SECOND: z.coerce.number().int().min(1).max(100).default(10),
  AI_PROVIDER: z.literal('mock'),
});
export type WorkerEnv = z.infer<typeof schema>;
export function parseWorkerEnv(input: NodeJS.ProcessEnv): WorkerEnv {
  const result = schema.safeParse({
    ...input,
    DATABASE_URL: input.WORKER_DATABASE_URL ?? input.DATABASE_URL,
    S3_ACCESS_KEY_ID: input.S3_ACCESS_KEY_ID ?? input.MINIO_ROOT_USER,
    S3_SECRET_ACCESS_KEY: input.S3_SECRET_ACCESS_KEY ?? input.MINIO_ROOT_PASSWORD,
  });
  if (!result.success)
    throw new Error(
      `Invalid worker environment: ${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}`,
    );
  try {
    parseEmbeddingConfiguration(input);
  } catch {
    throw new Error('Invalid worker environment: EMBEDDING_MODEL, EMBEDDING_DIMENSIONS');
  }
  return result.data;
}
