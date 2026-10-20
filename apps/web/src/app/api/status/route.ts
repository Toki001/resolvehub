import { readinessSchema } from '@resolvehub/contracts';
import { createApiClient } from '@resolvehub/generated';
import { parseWebEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  const env = parseWebEnv(process.env);
  const results = await Promise.allSettled([
    createApiClient(env.API_URL)
      .GET('/health/ready', { signal: AbortSignal.timeout(4_000), cache: 'no-store' })
      .then((result) => readinessSchema.parse(result.data ?? result.error)),
    fetch(new URL('/health/ready', env.WORKER_URL), {
      signal: AbortSignal.timeout(4_000),
      cache: 'no-store',
    }).then(async (response) => readinessSchema.parse(await response.json())),
  ]);
  const [api, worker] = results;
  const apiHealth = api?.status === 'fulfilled' ? api.value : null;
  const workerHealth = worker?.status === 'fulfilled' ? worker.value : null;
  const ready = apiHealth?.status === 'ready' && workerHealth?.status === 'ready';
  return Response.json(
    {
      status: ready ? 'ready' : 'not_ready',
      checkedAt: new Date().toISOString(),
      checks: {
        api: apiHealth ? 'up' : 'down',
        worker: workerHealth?.status === 'ready' ? 'up' : 'down',
        postgres: apiHealth?.checks.postgres ?? 'unknown',
        redis: apiHealth?.checks.redis ?? 'unknown',
        storage: apiHealth?.checks.storage ?? 'unknown',
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
