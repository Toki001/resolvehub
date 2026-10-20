import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Queue, QueueEvents } from 'bullmq';
import { PROBE_QUEUE, probeResultSchema, readinessSchema } from '@resolvehub/contracts';
import { Redis } from 'ioredis';

async function smoke() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');
  for (const [name, base] of [
    ['web', `${process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000'}/api/health`],
    ['api', `${process.env.API_URL ?? 'http://127.0.0.1:3001'}/health/ready`],
    ['worker', `${process.env.WORKER_URL ?? 'http://127.0.0.1:3002'}/health/ready`],
  ]) {
    if (!base) throw new Error('Missing health URL');
    const response = await fetch(base, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, `${name} must be healthy`);
    const body: unknown = await response.json();
    if (name !== 'web') assert.equal(readinessSchema.parse(body).status, 'ready');
    console.info(`${name}: healthy`);
  }

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 2_000 });
  const queue = new Queue(PROBE_QUEUE, { connection });
  const events = new QueueEvents(PROBE_QUEUE, { connection });
  try {
    await events.waitUntilReady();
    const requestId = randomUUID();
    const options = {
      jobId: requestId,
      attempts: 4,
      backoff: { type: 'exponential', delay: 250, jitter: 0.5 },
    };
    const job = await queue.add('health-probe', { requestId }, options);
    const duplicate = await queue.add('health-probe', { requestId }, options);
    assert.equal(duplicate.id, job.id);
    const result = probeResultSchema.parse(await job.waitUntilFinished(events, 10_000));
    assert.equal(result.requestId, requestId);
    assert.equal(await job.getState(), 'completed');
    await job.remove();
    console.info('BullMQ: probe processed by the standalone worker; duplicate job ID preserved');
  } finally {
    await events.close();
    await queue.close();
    connection.disconnect();
  }
}

const timeout = setTimeout(() => {
  console.error('Smoke check exceeded 30 seconds');
  process.exit(1);
}, 30_000);
timeout.unref();
smoke()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Smoke check failed');
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timeout));
