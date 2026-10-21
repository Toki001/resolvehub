import { z } from 'zod';

const schema = z.object({
  DASHBOARD_LOCAL_DEMO: z.enum(['true', 'false']).default('false'),
  DASHBOARD_LOCAL_DEMO_TOKEN: z
    .string()
    .regex(/^rh_[A-Za-z0-9_-]{43}$/)
    .optional(),
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
