import { createDatabase } from '@resolvehub/db';
import { readinessSchema, errorSchema } from '@resolvehub/contracts';

const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:3001';
const workerUrl = process.env.WORKER_URL ?? 'http://127.0.0.1:3002';

test.each([apiUrl, workerUrl])('running service is live and ready: %s', async (url) => {
  const live = await fetch(`${url}/health/live`, { signal: AbortSignal.timeout(5_000) });
  expect(live.status).toBe(200);
  expect(await live.json()).toMatchObject({ status: 'alive' });
  const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(5_000) });
  expect(response.status).toBe(200);
  expect(readinessSchema.parse(await response.json()).status).toBe('ready');
});

test('unknown API routes have safe, correlated errors', async () => {
  const response = await fetch(`${apiUrl}/v1/unknown`, { signal: AbortSignal.timeout(5_000) });
  expect(response.status).toBe(404);
  const body = errorSchema.parse(await response.json());
  expect(body.code).toBe('NOT_FOUND');
  expect(response.headers.get('x-request-id')).toBe(body.requestId);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

test('database bootstrap installed the actual pgvector extension', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { pool } = createDatabase(process.env.DATABASE_URL);
  try {
    const result = await pool.query("SELECT '[1,2,3]'::vector <-> '[1,2,3]'::vector AS distance");
    expect(result.rows[0]).toEqual({ distance: 0 });
  } finally {
    await pool.end();
  }
});

test('payload limits return a safe correlated error before routing', async () => {
  const response = await fetch(`${apiUrl}/health/live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'x'.repeat(70_000) }),
    signal: AbortSignal.timeout(5_000),
  });
  expect(response.status).toBe(413);
  const body = errorSchema.parse(await response.json());
  expect(body.code).toBe('PAYLOAD_TOO_LARGE');
  expect(response.headers.get('x-request-id')).toBe(body.requestId);
});
