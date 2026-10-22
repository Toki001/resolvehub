import { z } from 'zod';
import { EmbeddingProviderError } from '../provider-error.js';
import { generationOutputSchema, relevance } from './evidence.js';
import type { Evidence } from './evidence.js';
import type { DraftConfig } from './config.js';
import { tokenEstimate } from './config.js';

export interface GenerationInput {
  organizationId?: string;
  prompt: string;
  question: string;
  evidence: readonly Evidence[];
  maxOutputTokens: number;
}
export interface GenerationResult {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  tokenCountSource: 'mock_estimate' | 'provider_reported';
}
export interface GenerationProvider {
  readonly name: 'mock' | 'ollama' | 'gemini';
  readonly model: string;
  generate(input: GenerationInput, signal: AbortSignal): Promise<GenerationResult>;
}
export class ExtractiveMockProvider implements GenerationProvider {
  readonly name = 'mock';
  readonly model = 'resolvehub-extractive-mock-v1';
  async generate(input: GenerationInput, signal: AbortSignal): Promise<GenerationResult> {
    signal.throwIfAborted();
    const options = input.evidence.flatMap((row) =>
      row.text
        .split(/(?<=[.!?])\s+/)
        .filter((text) => text.length >= 12 && text.length <= 1000)
        .map((text) => ({ row, text, score: relevance(input.question, text) })),
    );
    options.sort((a, b) => b.score - a.score || a.row.chunkId.localeCompare(b.row.chunkId));
    const best = options[0];
    const output =
      best && best.score >= 1
        ? {
            kind: 'answer',
            claims: [{ chunkId: best.row.chunkId, text: best.text, quote: best.text }],
          }
        : { kind: 'insufficient_evidence', claims: [] };
    return {
      output,
      inputTokens: tokenEstimate(input.prompt),
      outputTokens: tokenEstimate(JSON.stringify(output)),
      tokenCountSource: 'mock_estimate',
    };
  }
}
export class OllamaDraftProvider implements GenerationProvider {
  readonly name = 'ollama';
  readonly model;
  constructor(
    private readonly config: DraftConfig,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.model = config.model;
  }
  async generate(input: GenerationInput, signal: AbortSignal): Promise<GenerationResult> {
    const response = await this.transport(new URL('/api/generate', this.config.baseUrl), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: input.prompt,
        stream: false,
        format: z.toJSONSchema(generationOutputSchema),
        options: { temperature: 0, num_predict: input.maxOutputTokens },
      }),
    });
    if (!response.ok) {
      const hint = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      throw new EmbeddingProviderError(response.status, Number.isFinite(hint) ? hint * 1000 : 0);
    }
    // Bound both declared and streamed lengths; never log untrusted provider bodies.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Provider response unavailable');
    const buffers: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65536) throw new Error('Provider response limit');
        buffers.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const result = z
      .object({
        model: z.literal(this.model),
        done: z.literal(true),
        response: z.string().max(20000),
        prompt_eval_count: z.number().int().nonnegative().max(1000000),
        eval_count: z.number().int().nonnegative().max(this.config.maxOutputTokens),
      })
      .parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
    let output: unknown;
    try {
      output = JSON.parse(result.response);
    } catch {
      output = null;
    }
    return {
      output,
      inputTokens: result.prompt_eval_count,
      outputTokens: result.eval_count,
      tokenCountSource: 'provider_reported',
    };
  }
}
