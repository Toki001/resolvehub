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

// Operational probes contain no tenant data. Domain jobs carry immutable
// identifiers; processors reload authoritative state and authorization.
export const PROBE_QUEUE = 'resolvehub-system-probes';
export const probeJobSchema = z.object({ requestId: z.uuid() }).strict();
export const probeResultSchema = z.object({
  requestId: z.uuid(),
  processedAt: z.iso.datetime(),
});
export type ProbeJob = z.infer<typeof probeJobSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const INGESTION_QUEUE = 'resolvehub-document-ingestion-v1';
export const ingestionJobSchema = z.object({ organizationId: z.uuid(), jobId: z.uuid() }).strict();
export type IngestionJob = z.infer<typeof ingestionJobSchema>;

export const aiProviderStatusSchema = z.object({
  mode: z.enum(['synthetic', 'gemini_live', 'unavailable']),
  provider: z.enum(['mock', 'ollama', 'gemini']),
  model: z.string().max(200),
  embeddingModel: z.string().max(200),
  canGenerate: z.boolean(),
  freeTierVerified: z.boolean(),
  reasonCode: z.string().max(80).nullable(),
  message: z.string().max(500),
  retryAfterSeconds: z.number().int().min(0).max(604800).nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
});
export type AiProviderStatus = z.infer<typeof aiProviderStatusSchema>;
export const aiStatusEnvelopeSchema = z.object({
  status: aiProviderStatusSchema,
  syntheticOrganizations: z.array(z.uuid()).max(10),
});
const aiMessages: Record<string, string> = {
  GEMINI_INVALID_REQUEST:
    'Gemini rejected the configured request. Live drafting is paused until the configuration is corrected.',
  GEMINI_MODEL_UNVERIFIED:
    'Gemini is paused until the selected model has been explicitly verified for free-tier use.',
  GEMINI_NOT_CONFIGURED: 'Gemini is unavailable. Add its key to the private backend environment.',
  GEMINI_FREE_TIER_UNVERIFIED:
    'Gemini is paused until its key and billing-disabled Free Tier project are manually verified again.',
  GEMINI_SYNTHETIC_SCOPE_REQUIRED:
    'Gemini is restricted to explicitly approved synthetic workspaces. No customer data was sent.',
  GEMINI_QUOTA_EXHAUSTED:
    'The Gemini free quota is exhausted. Live drafting is paused; no paid fallback will be used.',
  GEMINI_MINUTE_LIMIT:
    'The application’s free AI request limit was reached. Please wait before requesting another draft.',
  GEMINI_DAILY_LIMIT:
    'The application’s daily free AI request limit was reached. Live drafting is paused.',
  GEMINI_BUSY: 'Another free AI request is running. Please try again shortly.',
  GEMINI_TIMEOUT:
    'Gemini did not respond in time. Your ticket is saved; review processing history before retrying.',
  GEMINI_UNAVAILABLE:
    'Gemini is unavailable. Your records are saved, and no provider or paid model was substituted.',
  GEMINI_MODEL_UNAVAILABLE:
    'The requested Gemini model is not available to this project. Live drafting is paused; verify free model access in AI Studio. No model was substituted.',
  GEMINI_INVALID_RESPONSE: 'Gemini returned an unusable response. No reply was approved or sent.',
};
export function aiFailureMessage(code: string) {
  return aiMessages[code] ?? 'AI drafting is unavailable. Your support records are saved.';
}
