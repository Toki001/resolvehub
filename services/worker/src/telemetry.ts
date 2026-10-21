import type { createDatabase } from '@resolvehub/db';
import { queueSnapshot } from '@resolvehub/db';
import { gauge } from '@resolvehub/telemetry';

export function createQueueObserver(pool: ReturnType<typeof createDatabase>['pool']) {
  let pending: Promise<void> | undefined;
  let lastSuccess = Date.now();
  const tick = () => {
    if (pending || process.env.OTEL_ENABLED !== 'true') return;
    pending = queueSnapshot(pool)
      .then((rows) => {
        for (const row of rows) {
          const labels = { job_kind: row.job_kind };
          gauge('queue_pending', row.pending, labels);
          gauge('queue_active', row.active, labels);
          gauge('queue_oldest_age_seconds', row.oldest_age_seconds, labels);
          gauge('queue_dead_letters', row.dead_letters, labels);
          gauge('queue_retries_durable', row.retries, labels);
        }
        lastSuccess = Date.now();
      })
      .catch(() => {
        /* Preserve prior observations; expose their increasing age. */
      })
      .finally(() => {
        gauge('queue_observation_age_seconds', (Date.now() - lastSuccess) / 1000);
        pending = undefined;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      await pending;
    },
  };
}
