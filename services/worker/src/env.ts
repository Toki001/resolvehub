import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.url().refine((url) => /^rediss?:/.test(url)),
  WORKER_HOST: z.string().min(1).default('127.0.0.1'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  AI_PROVIDER: z.literal('mock'),
});

export function parseWorkerEnv(input: NodeJS.ProcessEnv) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid worker environment: ${fields.join(', ')}`);
  }
  return result.data;
}
