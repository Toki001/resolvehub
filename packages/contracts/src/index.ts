import { z } from 'zod';

export const componentStatusSchema = z.enum(['up', 'down']);
export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  service: z.enum(['api', 'worker']),
  checks: z.record(z.string(), componentStatusSchema),
});
export type Readiness = z.infer<typeof readinessSchema>;

export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.uuid(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof errorSchema>;

// Operational probes contain no tenant data. Domain queues require authenticated,
// tenant-scoped contracts and a durable application DLQ in a later milestone.
export const PROBE_QUEUE = 'resolvehub-system-probes';
export const probeJobSchema = z.object({ requestId: z.uuid() }).strict();
export const probeResultSchema = z.object({
  requestId: z.uuid(),
  processedAt: z.iso.datetime(),
});
export type ProbeJob = z.infer<typeof probeJobSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
