import { createHash } from 'node:crypto';
import { draftConfigSchema, parseGeminiConfig } from '@resolvehub/ai';

export const geminiOrganization = '60000000-0000-4000-8000-000000000001';
export const geminiTestKey = 'synthetic_gemini_key_never_live_1234567890';
export function geminiAccess(organizationId = geminiOrganization) {
  return parseGeminiConfig({
    GEMINI_API_KEY: geminiTestKey,
    GEMINI_PROJECT_ID: 'synthetic-free-project',
    GEMINI_FREE_TIER_KEY_SHA256: createHash('sha256').update(geminiTestKey).digest('hex'),
    GEMINI_FREE_TIER_VERIFIED_AT: new Date().toISOString(),
    GEMINI_BILLING_DISABLED: 'true',
    GEMINI_FREE_TIER_CONFIRMED: 'true',
    GEMINI_SYNTHETIC_ONLY: 'true',
    GEMINI_SYNTHETIC_ORGANIZATION_IDS: organizationId,
  });
}
export const geminiDraftConfig = () =>
  draftConfigSchema.parse({ provider: 'gemini', model: 'gemini-2.5-flash-lite' });
export function geminiResponse(output: unknown, finishReason = 'STOP') {
  return Response.json({
    candidates: [
      { content: { role: 'model', parts: [{ text: JSON.stringify(output) }] }, finishReason },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
    modelVersion: 'gemini-2.5-flash-lite',
  });
}
