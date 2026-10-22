import { z } from 'zod';

export const draftConfigSchema = z.object({
  provider: z.enum(['mock', 'ollama', 'gemini']).default('mock'),
  model: z.string().min(1).max(200).default('resolvehub-extractive-mock-v1'),
  baseUrl: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    })
    .default('http://127.0.0.1:11434'),
  rerank: z.boolean().default(true),
  maxPromptTokens: z.number().int().min(1024).max(16384).default(4096),
  maxOutputTokens: z.number().int().min(64).max(1024).default(512),
  timeoutMs: z.number().int().min(100).max(30000).default(5000),
  maxCostUsd: z.number().min(0).max(0.02).default(0.02),
  inputUsdPerMillion: z.number().finite().min(0).max(1000).default(0),
  outputUsdPerMillion: z.number().finite().min(0).max(1000).default(0),
  priceDate: z.iso.date().default('2026-10-22'),
});
export type DraftConfig = z.infer<typeof draftConfigSchema>;
export function parseDraftConfig(env: NodeJS.ProcessEnv): DraftConfig {
  try {
    if (
      env.DRAFT_PROVIDER === 'ollama' &&
      (!env.DRAFT_MODEL ||
        env.DRAFT_INPUT_USD_PER_MILLION === undefined ||
        env.DRAFT_OUTPUT_USD_PER_MILLION === undefined ||
        !env.DRAFT_PRICE_DATE)
    )
      throw new Error('Missing explicit model/prices');
    const config = draftConfigSchema.parse({
      provider: env.DRAFT_PROVIDER,
      model: env.DRAFT_MODEL,
      baseUrl: env.OLLAMA_BASE_URL,
      rerank:
        env.DRAFT_RERANK === undefined
          ? undefined
          : z.enum(['true', 'false']).parse(env.DRAFT_RERANK) === 'true',
      timeoutMs: env.DRAFT_TIMEOUT_MS === undefined ? undefined : Number(env.DRAFT_TIMEOUT_MS),
      maxPromptTokens:
        env.DRAFT_MAX_PROMPT_TOKENS === undefined ? undefined : Number(env.DRAFT_MAX_PROMPT_TOKENS),
      maxOutputTokens:
        env.DRAFT_MAX_OUTPUT_TOKENS === undefined ? undefined : Number(env.DRAFT_MAX_OUTPUT_TOKENS),
      inputUsdPerMillion:
        env.DRAFT_INPUT_USD_PER_MILLION === undefined
          ? undefined
          : Number(env.DRAFT_INPUT_USD_PER_MILLION),
      outputUsdPerMillion:
        env.DRAFT_OUTPUT_USD_PER_MILLION === undefined
          ? undefined
          : Number(env.DRAFT_OUTPUT_USD_PER_MILLION),
      priceDate: env.DRAFT_PRICE_DATE,
    });
    if (config.provider === 'ollama' && config.model === 'resolvehub-extractive-mock-v1')
      throw new Error('Ollama model must be explicit');
    if (config.provider === 'mock' && config.model !== 'resolvehub-extractive-mock-v1')
      throw new Error('Mock model mismatch');
    if (
      config.provider === 'gemini' &&
      (config.model !== 'gemini-3.5-flash-lite' ||
        config.inputUsdPerMillion !== 0 ||
        config.outputUsdPerMillion !== 0 ||
        config.maxPromptTokens > 4096 ||
        config.maxOutputTokens > 512)
    )
      throw new Error('Gemini permits only the verified free text model and conservative bounds');
    return config;
  } catch {
    throw new Error(
      'Invalid draft configuration: DRAFT_PROVIDER, DRAFT_MODEL, DRAFT_RERANK, DRAFT_TIMEOUT_MS, DRAFT_MAX_PROMPT_TOKENS, DRAFT_MAX_OUTPUT_TOKENS, DRAFT_INPUT_USD_PER_MILLION, DRAFT_OUTPUT_USD_PER_MILLION, DRAFT_PRICE_DATE, OLLAMA_BASE_URL',
    );
  }
}
// Mock estimates are labelled. Bytes also give a conservative prompt budget bound.
export const tokenEstimate = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
export function estimateCost(inputTokens: number, outputTokens: number, config: DraftConfig) {
  return Number(
    (
      (inputTokens * config.inputUsdPerMillion + outputTokens * config.outputUsdPerMillion) /
      1_000_000
    ).toFixed(8),
  );
}
