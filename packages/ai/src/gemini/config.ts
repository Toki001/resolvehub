import { createHash } from 'node:crypto';
import { z } from 'zod';

export const GEMINI_MODEL = 'gemini-2.5-flash-lite';
export const GEMINI_ATTESTATION_AGE_MS = 24 * 60 * 60 * 1000;
const schema = z.object({
  apiKey: z
    .string()
    .min(20)
    .max(2048)
    .regex(/^[^\s\p{Cc}]+$/u)
    .optional(),
  projectId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,62}$/)
    .optional(),
  verifiedAt: z.iso.datetime().optional(),
  keySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  billingDisabled: z.boolean().default(false),
  freeTier: z.boolean().default(false),
  syntheticOnly: z.boolean().default(false),
  organizations: z.array(z.uuid()).max(10).default([]),
  requestsPerMinute: z.number().int().min(1).max(5).default(2),
  requestsPerDay: z.number().int().min(1).max(100).default(10),
  concurrency: z.number().int().min(1).max(2).default(1),
});
export type GeminiConfig = z.infer<typeof schema>;
export function parseGeminiConfig(env: NodeJS.ProcessEnv): GeminiConfig {
  const boolean = (value: string | undefined) =>
    value === undefined ? false : z.enum(['true', 'false']).parse(value) === 'true';
  try {
    return schema.parse({
      apiKey: env.GEMINI_API_KEY || undefined,
      projectId: env.GEMINI_PROJECT_ID || undefined,
      verifiedAt: env.GEMINI_FREE_TIER_VERIFIED_AT || undefined,
      keySha256: env.GEMINI_FREE_TIER_KEY_SHA256 || undefined,
      billingDisabled: boolean(env.GEMINI_BILLING_DISABLED),
      freeTier: boolean(env.GEMINI_FREE_TIER_CONFIRMED),
      syntheticOnly: boolean(env.GEMINI_SYNTHETIC_ONLY),
      organizations: env.GEMINI_SYNTHETIC_ORGANIZATION_IDS?.split(',').filter(Boolean),
      requestsPerMinute:
        env.GEMINI_REQUESTS_PER_MINUTE === undefined
          ? undefined
          : Number(env.GEMINI_REQUESTS_PER_MINUTE),
      requestsPerDay:
        env.GEMINI_REQUESTS_PER_DAY === undefined ? undefined : Number(env.GEMINI_REQUESTS_PER_DAY),
      concurrency:
        env.GEMINI_CONCURRENCY === undefined ? undefined : Number(env.GEMINI_CONCURRENCY),
    });
  } catch {
    throw new Error(
      'Invalid Gemini configuration: GEMINI_API_KEY, GEMINI_PROJECT_ID, GEMINI_FREE_TIER_VERIFIED_AT, GEMINI_FREE_TIER_KEY_SHA256, GEMINI_BILLING_DISABLED, GEMINI_FREE_TIER_CONFIRMED, GEMINI_SYNTHETIC_ONLY, GEMINI_SYNTHETIC_ORGANIZATION_IDS, GEMINI_REQUESTS_PER_MINUTE, GEMINI_REQUESTS_PER_DAY, GEMINI_CONCURRENCY',
    );
  }
}
export function geminiEligibility(config: GeminiConfig, now = Date.now()): string | null {
  if (!config.apiKey) return 'GEMINI_NOT_CONFIGURED';
  if (
    !config.projectId ||
    !config.freeTier ||
    !config.billingDisabled ||
    !config.verifiedAt ||
    now - Date.parse(config.verifiedAt) < 0 ||
    now - Date.parse(config.verifiedAt) > GEMINI_ATTESTATION_AGE_MS ||
    createHash('sha256').update(config.apiKey).digest('hex') !== config.keySha256
  )
    return 'GEMINI_FREE_TIER_UNVERIFIED';
  if (!config.syntheticOnly || !config.organizations.length)
    return 'GEMINI_SYNTHETIC_SCOPE_REQUIRED';
  return null;
}
export class GeminiFailure extends Error {
  constructor(
    readonly category: string,
    readonly retryAfterMs = 0,
    readonly transient = false,
  ) {
    super(category);
    this.name = 'GeminiFailure';
  }
}
export interface GeminiBudget {
  acquire(signal: AbortSignal): Promise<string>;
  release(lease: string): Promise<void>;
  failed(failure: GeminiFailure): Promise<void>;
  succeeded(inputTokens: number, outputTokens: number): Promise<void>;
}
export function retryAfterMs(header: string | null, now = Date.now()) {
  if (!header) return 0;
  const value = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(value) ? Math.max(0, Math.min(7 * 86400000, value)) : 0;
}
