import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { GEMINI_MODEL, GeminiFailure, geminiEligibility } from './config.js';
import type { GeminiConfig } from './config.js';

export const discoveryCandidates = [
  'gemini-2.5-flash-lite',
  GEMINI_MODEL,
  'gemini-3.1-flash-lite',
] as const;

// Metadata discovery never generates content or establishes a billing tier.
// Only safe model metadata is returned; raw SDK/provider errors stay private.
export async function discoverGeminiModels(access: GeminiConfig, transport: typeof fetch = fetch) {
  const eligibility = geminiEligibility(access);
  if (eligibility && eligibility !== 'GEMINI_MODEL_UNVERIFIED')
    throw new GeminiFailure(eligibility);
  let requests = 0;
  const signal = AbortSignal.timeout(15000);
  const models: {
    name: string;
    supportedActions: string[];
    inputTokenLimit: number | null;
    outputTokenLimit: number | null;
  }[] = [];
  try {
    const sdk = new GoogleGenAI({
      apiKey: z.string().parse(access.apiKey),
      apiVersion: 'v1beta',
      vertexai: false,
      enterprise: false,
      httpOptions: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        timeout: 15000,
        retryOptions: { attempts: 1 },
        fetch: async (url: unknown, init) => {
          const target = new URL(z.string().parse(url));
          if (
            target.origin !== 'https://generativelanguage.googleapis.com' ||
            target.pathname !== '/v1beta/models' ||
            [...target.searchParams.keys()].some(
              (key) => !['pageSize', 'pageToken'].includes(key),
            ) ||
            init?.method !== 'GET' ||
            ++requests > 3
          )
            throw new GeminiFailure('GEMINI_DISCOVERY_LIMIT');
          const response = await transport(target, { ...init, signal, redirect: 'error' });
          if (!response.ok) {
            await response.body?.cancel();
            throw new GeminiFailure('GEMINI_DISCOVERY_UNAVAILABLE');
          }
          const reader = response.body?.getReader();
          if (!reader) throw new GeminiFailure('GEMINI_DISCOVERY_UNAVAILABLE');
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > 1048576) throw new GeminiFailure('GEMINI_DISCOVERY_LIMIT');
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel();
          }
          return new Response(Buffer.concat(chunks), {
            status: response.status,
            headers: response.headers,
          });
        },
      },
    });
    const pages = await sdk.models.list({ config: { pageSize: 1000 } });
    let totalListed = 0;
    for await (const model of pages) {
      totalListed++;
      if (discoveryCandidates.some((name) => model.name === `models/${name}`))
        models.push({
          name: z.string().parse(model.name),
          supportedActions: z.array(z.string().max(100)).max(20).parse(model.supportedActions),
          inputTokenLimit: z
            .number()
            .int()
            .positive()
            .nullable()
            .parse(model.inputTokenLimit ?? null),
          outputTokenLimit: z
            .number()
            .int()
            .positive()
            .nullable()
            .parse(model.outputTokenLimit ?? null),
        });
    }
    return { apiVersion: 'v1beta' as const, requests, totalListed, models };
  } catch (error) {
    throw error instanceof GeminiFailure
      ? error
      : new GeminiFailure('GEMINI_DISCOVERY_UNAVAILABLE');
  }
}
