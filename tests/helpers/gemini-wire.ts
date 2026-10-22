import { z } from 'zod';
import { GEMINI_MODEL } from '@resolvehub/ai';

// Offline HTTP boundary for the real @google/genai adapter. Never delegates to
// global fetch. Tokens are deterministic fixture metadata, not live measurements.
export type GeminiScenario =
  | 'valid'
  | 'missing_citations'
  | 'invalid_citations'
  | 'empty'
  | 'invalid_json'
  | 'timeout'
  | 'quota'
  | 'invalid_model'
  | 'unavailable'
  | 'truncated'
  | 'invalid_metadata';
export function geminiWire(
  scenario: GeminiScenario,
  claim: { chunkId: string; text: string; quote: string },
) {
  const requests: { serverDeadlineSeconds: number; prompt: string; model: string }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const endpoint = new URL(String(url));
    if (
      endpoint.origin !== 'https://generativelanguage.googleapis.com' ||
      endpoint.pathname !== `/v1beta/models/${GEMINI_MODEL}:generateContent` ||
      endpoint.search ||
      init?.method !== 'POST'
    )
      throw new Error('Unexpected offline Gemini request');
    const body = z
      .object({
        contents: z.array(z.object({ parts: z.array(z.object({ text: z.string() })) })),
        generationConfig: z.object({ maxOutputTokens: z.number().max(512) }),
      })
      .parse(JSON.parse(String(init.body)));
    const deadline = Number(new Headers(init.headers).get('x-server-timeout'));
    requests.push({
      serverDeadlineSeconds: deadline,
      prompt: body.contents.flatMap((content) => content.parts.map((part) => part.text)).join('\n'),
      model: GEMINI_MODEL,
    });
    // Reproduce the provider rejection reported in livekit/agents#3723.
    if (deadline < 10)
      return Response.json(
        {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: `Manually set deadline ${deadline}s is too short. Minimum allowed deadline is 10s.`,
          },
        },
        { status: 400 },
      );
    if (scenario === 'timeout') return new Promise<Response>(() => undefined);
    if (scenario === 'quota' || scenario === 'invalid_model' || scenario === 'unavailable') {
      const status = scenario === 'quota' ? 429 : scenario === 'invalid_model' ? 404 : 503;
      return Response.json(
        { error: { code: status, message: 'Private fixture diagnostic' } },
        {
          status,
          headers: { 'Retry-After': '2' },
        },
      );
    }
    const output = {
      kind: 'answer',
      claims:
        scenario === 'missing_citations'
          ? []
          : [
              {
                ...claim,
                chunkId:
                  scenario === 'invalid_citations'
                    ? '70000000-0000-4000-8000-000000000099'
                    : claim.chunkId,
              },
            ],
    };
    const text =
      scenario === 'empty' ? '' : scenario === 'invalid_json' ? '{"kind":' : JSON.stringify(output);
    return Response.json({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text }] },
          finishReason: scenario === 'truncated' ? 'MAX_TOKENS' : 'STOP',
        },
      ],
      modelVersion: GEMINI_MODEL,
      responseId: 'offline-gemini-response',
      usageMetadata: {
        promptTokenCount: scenario === 'invalid_metadata' ? -1 : 120,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 0,
        totalTokenCount: 150,
      },
    });
  };
  return { transport, requests };
}
