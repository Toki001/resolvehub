import { z } from 'zod';
import { parseEmbeddingConfiguration } from '@resolvehub/db';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_SECRET_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  DATABASE_URL: z.url().refine((url) => /^postgres(ql)?:/.test(url)),
  REDIS_URL: z.url().refine((url) => /^rediss?:/.test(url)),
  S3_ENDPOINT: z.url().refine((url) => /^https?:/.test(url)),
  WEB_ORIGIN: z.url().refine((url) => new URL(url).origin === url),
});

export type ApiEnv = z.infer<typeof schema>;
export const API_ENV = Symbol('API_ENV');

export function parseApiEnv(input: NodeJS.ProcessEnv): ApiEnv {
  const result = schema.safeParse(input);
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
