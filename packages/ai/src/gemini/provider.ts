import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { count, observe } from '@resolvehub/telemetry';
import type { DraftConfig } from '../drafting/config.js';
import type {
  GenerationInput,
  GenerationProvider,
  GenerationResult,
} from '../drafting/provider.js';
import { GEMINI_MODEL, GeminiFailure, geminiEligibility, retryAfterMs } from './config.js';
import type { GeminiBudget, GeminiConfig } from './config.js';

const outputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['answer', 'insufficient_evidence'] },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          chunkId: { type: 'string' },
          text: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['chunkId', 'text', 'quote'],
      },
    },
  },
  required: ['kind', 'claims'],
};
// No Vertex, tools, grounding, cache, batch, model fallback or SDK retries.
// A manual, key-bound free-tier attestation is checked before EVERY call.
export class GeminiDraftProvider implements GenerationProvider {
  readonly name = 'gemini';
  readonly model = GEMINI_MODEL;
  constructor(
    private readonly access: GeminiConfig,
    private readonly config: DraftConfig,
    private readonly budget: GeminiBudget,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (
      config.provider !== 'gemini' ||
      config.model !== GEMINI_MODEL ||
      config.maxOutputTokens > 512 ||
      config.maxPromptTokens > 4096 ||
      config.inputUsdPerMillion !== 0 ||
      config.outputUsdPerMillion !== 0
    )
      throw new Error('Invalid free-tier Gemini model configuration');
  }
  async generate(input: GenerationInput, parent: AbortSignal): Promise<GenerationResult> {
    const eligibility = geminiEligibility(this.access);
    if (eligibility) throw new GeminiFailure(eligibility);
    if (!input.organizationId || !this.access.organizations.includes(input.organizationId))
      throw new GeminiFailure('GEMINI_SYNTHETIC_SCOPE_REQUIRED');
    if (
      Buffer.byteLength(input.prompt) > this.config.maxPromptTokens ||
      input.maxOutputTokens > this.config.maxOutputTokens ||
      input.maxOutputTokens < 1
    )
      throw new GeminiFailure('GEMINI_INPUT_LIMIT');
    const signal = AbortSignal.any([parent, AbortSignal.timeout(this.config.timeoutMs)]);
    signal.throwIfAborted();
    const lease = await this.budget.acquire(signal);
    let status = 0,
      retry = 0;
    const start = performance.now();
    try {
      const sdk = new GoogleGenAI({
        apiKey: z.string().parse(this.access.apiKey),
        enterprise: false,
        vertexai: false,
        apiVersion: 'v1beta',
        httpOptions: {
          baseUrl: 'https://generativelanguage.googleapis.com',
          timeout: this.config.timeoutMs,
          retryOptions: { attempts: 1 },
          fetch: async (url: unknown, init) => {
            const target = new URL(z.string().parse(url));
            if (
              target.origin !== 'https://generativelanguage.googleapis.com' ||
              target.search ||
              target.pathname !== `/v1beta/models/${GEMINI_MODEL}:generateContent` ||
              init?.method !== 'POST'
            )
              throw new GeminiFailure('GEMINI_ENDPOINT_BLOCKED');
            count('provider_requests', 1, { provider: 'gemini', model: GEMINI_MODEL });
            const response = await this.transport(target, { ...init, signal, redirect: 'error' });
            status = response.status;
            retry = retryAfterMs(response.headers.get('retry-after'));
            if (!response.ok) {
              await response.body?.cancel();
              throw new GeminiFailure(
                status === 429
                  ? 'GEMINI_QUOTA_EXHAUSTED'
                  : status === 404
                    ? 'GEMINI_MODEL_UNAVAILABLE'
                    : 'GEMINI_UNAVAILABLE',
                retry,
                status >= 500 || status === 408,
              );
            }
            const reader = response.body?.getReader();
            if (!reader) throw new GeminiFailure('GEMINI_INVALID_RESPONSE');
            const buffers: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > 65536) throw new GeminiFailure('GEMINI_INVALID_RESPONSE');
                buffers.push(chunk.value);
              }
            } finally {
              await reader.cancel();
            }
            return new Response(Buffer.concat(buffers), {
              status: response.status,
              headers: response.headers,
            });
          },
        },
      });
      const operation = sdk.models.generateContent({
        model: GEMINI_MODEL,
        contents: input.prompt,
        config: {
          abortSignal: signal,
          temperature: 0,
          candidateCount: 1,
          maxOutputTokens: input.maxOutputTokens,
          thinkingConfig: { thinkingBudget: 0 },
          automaticContinuation: false,
          responseMimeType: 'application/json',
          responseJsonSchema: outputSchema,
        },
      });
      let abort: () => void = () => undefined;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new GeminiFailure('GEMINI_TIMEOUT', 1000, true));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = await Promise.race([operation, interrupted]).finally(() =>
        signal.removeEventListener('abort', abort),
      );
      if (
        !result.modelVersion ||
        (result.modelVersion !== GEMINI_MODEL &&
          !result.modelVersion.startsWith(`${GEMINI_MODEL}-`))
      )
        throw new GeminiFailure('GEMINI_INVALID_RESPONSE');
      const inputTokens = z
        .number()
        .int()
        .min(0)
        .max(4096)
        .parse(result.usageMetadata?.promptTokenCount);
      const outputTokens = z
        .number()
        .int()
        .min(0)
        .max(input.maxOutputTokens)
        .parse(
          (result.usageMetadata?.candidatesTokenCount ?? -1) +
            (result.usageMetadata?.thoughtsTokenCount ?? 0),
        );
      let output: unknown = null;
      if (result.candidates?.length === 1 && result.candidates[0]?.finishReason === 'STOP') {
        try {
          output = JSON.parse(result.text ?? '');
        } catch {
          /* Runtime pipeline validation abstains. */
        }
      }
      await this.budget.succeeded(inputTokens, outputTokens);
      return { output, inputTokens, outputTokens, tokenCountSource: 'provider_reported' };
    } catch (error) {
      const failure =
        error instanceof GeminiFailure
          ? error
          : new GeminiFailure(
              signal.aborted
                ? 'GEMINI_TIMEOUT'
                : status === 404
                  ? 'GEMINI_MODEL_UNAVAILABLE'
                  : status === 429
                    ? 'GEMINI_QUOTA_EXHAUSTED'
                    : 'GEMINI_UNAVAILABLE',
              retry,
              signal.aborted || status === 0 || status >= 500 || status === 408,
            );
      if (failure.category === 'GEMINI_QUOTA_EXHAUSTED')
        count('provider_quota_exhausted', 1, { provider: 'gemini', model: GEMINI_MODEL });
      await this.budget.failed(failure);
      throw failure;
    } finally {
      observe('provider_request_duration_seconds', (performance.now() - start) / 1000, {
        provider: 'gemini',
        model: GEMINI_MODEL,
      });
      await this.budget.release(lease);
    }
  }
}
