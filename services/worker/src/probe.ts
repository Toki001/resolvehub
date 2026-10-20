import { UnrecoverableError } from 'bullmq';
import { probeJobSchema } from '@resolvehub/contracts';
import type { ProbeResult } from '@resolvehub/contracts';

export function processProbe(name: string, data: unknown): ProbeResult {
  const input = probeJobSchema.safeParse(data);
  if (name !== 'health-probe' || !input.success) {
    throw new UnrecoverableError('INVALID_SYSTEM_PROBE');
  }
  return { requestId: input.data.requestId, processedAt: new Date().toISOString() };
}
