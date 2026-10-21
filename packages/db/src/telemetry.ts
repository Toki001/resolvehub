import type pg from 'pg';
import { z } from 'zod';
import { tenantTransaction } from './tenant.js';
import { validTraceparent } from '@resolvehub/telemetry';

export async function jobTraceContext(
  pool: pg.Pool,
  organizationId: string,
  jobId: string,
): Promise<string | undefined> {
  z.uuid().parse(jobId);
  return tenantTransaction(pool, organizationId, async (client) => {
    const result = await client.query<{ trace_context: unknown }>(
      'SELECT trace_context FROM job_runs WHERE organization_id=$1 AND id=$2',
      [organizationId, jobId],
    );
    const parsed = z
      .object({ traceparent: z.string().optional() })
      .safeParse(result.rows[0]?.trace_context);
    return parsed.success && validTraceparent(parsed.data.traceparent)
      ? parsed.data.traceparent
      : undefined;
  });
}
export async function queueSnapshot(pool: pg.Pool) {
  const result = await pool.query('SELECT * FROM operational_queue_snapshot()');
  return z
    .array(
      z.object({
        job_kind: z.enum(['document_ingestion', 'draft_response']),
        pending: z.coerce.number().int().nonnegative(),
        active: z.coerce.number().int().nonnegative(),
        oldest_age_seconds: z.coerce.number().nonnegative(),
        dead_letters: z.coerce.number().int().nonnegative(),
        retries: z.coerce.number().int().nonnegative(),
      }),
    )
    .parse(result.rows);
}
