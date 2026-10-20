import { z } from 'zod';

const schema = z.object({
  API_URL: z
    .url()
    .refine((url) => /^https?:/.test(url))
    .default('http://127.0.0.1:3001'),
  WORKER_URL: z
    .url()
    .refine((url) => /^https?:/.test(url))
    .default('http://127.0.0.1:3002'),
});

export function parseWebEnv(input: NodeJS.ProcessEnv) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid web environment: ${fields.join(', ')}`);
  }
  return result.data;
}
