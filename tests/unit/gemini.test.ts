import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GeminiDraftProvider,
  geminiEligibility,
  parseGeminiConfig,
  parseDraftConfig,
  retryAfterMs,
} from '@resolvehub/ai';
import type { GeminiBudget, GeminiConfig } from '@resolvehub/ai';
import { parseEmbeddingConfiguration } from '@resolvehub/db';
import {
  geminiAccess,
  geminiDraftConfig,
  geminiOrganization,
  geminiResponse,
} from '../helpers/gemini.js';

function budget() {
  return {
    acquire: jest.fn<GeminiBudget['acquire']>().mockResolvedValue('lease'),
    release: jest.fn<GeminiBudget['release']>().mockResolvedValue(),
    failed: jest.fn<GeminiBudget['failed']>().mockResolvedValue(),
    succeeded: jest.fn<GeminiBudget['succeeded']>().mockResolvedValue(),
  };
}
const input = {
  organizationId: geminiOrganization,
  prompt: 'Synthetic evidence only.',
  question: 'What is the refund window?',
  evidence: [],
  maxOutputTokens: 512,
};
const signal = () => new AbortController().signal;

test('official SDK sends exactly one bounded standard text request and reports measured usage', async () => {
  const transport = jest
    .fn<typeof fetch>()
    .mockResolvedValue(geminiResponse({ kind: 'insufficient_evidence', claims: [] }));
  const limits = budget();
  const result = await new GeminiDraftProvider(
    geminiAccess(),
    geminiDraftConfig(),
    limits,
    transport,
  ).generate(input, signal());
  expect(result).toMatchObject({
    inputTokens: 120,
    outputTokens: 30,
    tokenCountSource: 'provider_reported',
    output: { kind: 'insufficient_evidence' },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  const [url, options] = transport.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
  );
  expect(options?.redirect).toBe('error');
  const body: unknown = JSON.parse(String(options?.body));
  expect(body).toMatchObject({
    generationConfig: {
      maxOutputTokens: 512,
      candidateCount: 1,
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    },
  });
  for (const field of ['tools', 'cachedContent', 'serviceTier', 'continuationToken'])
    expect(body).not.toHaveProperty(field);
  expect(limits.release).toHaveBeenCalledWith('lease');
  expect(limits.succeeded).toHaveBeenCalledWith(120, 30);
});

test.each([
  { apiKey: undefined },
  { freeTier: false },
  { billingDisabled: false },
  { projectId: undefined },
  { keySha256: '0'.repeat(64) },
  { verifiedAt: undefined },
  { verifiedAt: new Date(Date.now() - 86400001).toISOString() },
  { verifiedAt: new Date(Date.now() + 86400000).toISOString() },
  { syntheticOnly: false },
  { organizations: [] },
])('free eligibility is not inferred from a usable key: %j', async (override) => {
  const config: GeminiConfig = { ...geminiAccess(), ...override };
  expect(geminiEligibility(config)).not.toBeNull();
  const transport = jest.fn<typeof fetch>();
  const limits = budget();
  await expect(
    new GeminiDraftProvider(config, geminiDraftConfig(), limits, transport).generate(
      input,
      signal(),
    ),
  ).rejects.toThrow('GEMINI_');
  expect(transport).not.toHaveBeenCalled();
  expect(limits.acquire).not.toHaveBeenCalled();
});

test('unapproved tenants and missing tenant context cannot send a prompt', async () => {
  const transport = jest.fn<typeof fetch>();
  const provider = new GeminiDraftProvider(
    geminiAccess(),
    geminiDraftConfig(),
    budget(),
    transport,
  );
  await expect(
    provider.generate({ ...input, organizationId: randomUUID() }, signal()),
  ).rejects.toThrow('GEMINI_SYNTHETIC_SCOPE_REQUIRED');
  const withoutTenant = {
    prompt: input.prompt,
    question: input.question,
    evidence: input.evidence,
    maxOutputTokens: input.maxOutputTokens,
  };
  await expect(provider.generate(withoutTenant, signal())).rejects.toThrow(
    'GEMINI_SYNTHETIC_SCOPE_REQUIRED',
  );
  expect(transport).not.toHaveBeenCalled();
});

test.each([429, 403, 404, 500, 503])(
  'HTTP %i is sanitized, not silently retried or redirected to another provider',
  async (status) => {
    const transport = jest.fn<typeof fetch>().mockResolvedValue(
      new Response('secret-provider-body-must-not-escape', {
        status,
        headers: { 'Retry-After': '2' },
      }),
    );
    const limits = budget();
    const provider = new GeminiDraftProvider(
      geminiAccess(),
      geminiDraftConfig(),
      limits,
      transport,
    );
    let observed: unknown;
    try {
      await provider.generate(input, signal());
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      category:
        status === 429
          ? 'GEMINI_QUOTA_EXHAUSTED'
          : status === 404
            ? 'GEMINI_MODEL_UNAVAILABLE'
            : 'GEMINI_UNAVAILABLE',
      retryAfterMs: 2000,
      transient: status >= 500,
    });
    expect(String(observed)).not.toContain('secret-provider-body');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(limits.failed).toHaveBeenCalledTimes(1);
    expect(limits.release).toHaveBeenCalledTimes(1);
  },
);

test('a provider ignoring cancellation is still bounded by the adapter deadline', async () => {
  const transport = jest.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
  const limits = budget();
  const config = { ...geminiDraftConfig(), timeoutMs: 100 };
  await expect(
    new GeminiDraftProvider(geminiAccess(), config, limits, transport).generate(input, signal()),
  ).rejects.toMatchObject({ category: 'GEMINI_TIMEOUT' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(limits.release).toHaveBeenCalledTimes(1);
});

test('aborted requests, excessive prompts, and model/token/price changes fail before cloud access', async () => {
  const transport = jest.fn<typeof fetch>();
  const provider = new GeminiDraftProvider(
    geminiAccess(),
    geminiDraftConfig(),
    budget(),
    transport,
  );
  await expect(provider.generate(input, AbortSignal.abort())).rejects.toThrow();
  for (const change of [
    { prompt: 'x'.repeat(4097) },
    { maxOutputTokens: 513 },
    { maxOutputTokens: 0 },
  ])
    await expect(provider.generate({ ...input, ...change }, signal())).rejects.toThrow(
      'GEMINI_INPUT_LIMIT',
    );
  for (const change of [
    { model: 'paid-model' },
    { maxOutputTokens: 513 },
    { maxPromptTokens: 4097 },
    { inputUsdPerMillion: 1 },
  ])
    expect(
      () =>
        new GeminiDraftProvider(
          geminiAccess(),
          { ...geminiDraftConfig(), ...change },
          budget(),
          transport,
        ),
    ).toThrow();
  expect(transport).not.toHaveBeenCalled();
});

test.each(['MAX_TOKENS', 'SAFETY', 'CONTINUATION'])(
  'incomplete output (%s) is never accepted as an answer',
  async (finish) => {
    const provider = new GeminiDraftProvider(
      geminiAccess(),
      geminiDraftConfig(),
      budget(),
      async () => geminiResponse({ kind: 'answer', claims: [] }, finish),
    );
    expect((await provider.generate(input, signal())).output).toBeNull();
  },
);
test('oversized provider output is rejected without leaking its body', async () => {
  const transport = jest.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(65537)));
  await expect(
    new GeminiDraftProvider(geminiAccess(), geminiDraftConfig(), budget(), transport).generate(
      input,
      signal(),
    ),
  ).rejects.toThrow('GEMINI_');
});
test('a response naming another model is rejected instead of silently substituting it', async () => {
  const original: unknown = await geminiResponse({
    kind: 'insufficient_evidence',
    claims: [],
  }).json();
  const body = z.record(z.string(), z.unknown()).parse(original);
  const transport = jest
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...body, modelVersion: 'another-model' }));
  await expect(
    new GeminiDraftProvider(geminiAccess(), geminiDraftConfig(), budget(), transport).generate(
      input,
      signal(),
    ),
  ).rejects.toThrow('GEMINI_INVALID_RESPONSE');
  expect(transport).toHaveBeenCalledTimes(1);
});
test('missing usage and malformed JSON remain failures or abstentions rather than invented token counts', async () => {
  const malformed = geminiResponse({});
  const missing = new GeminiDraftProvider(geminiAccess(), geminiDraftConfig(), budget(), async () =>
    Response.json({ candidates: [] }),
  );
  await expect(missing.generate(input, signal())).rejects.toThrow('GEMINI_');
  const provider = new GeminiDraftProvider(
    geminiAccess(),
    geminiDraftConfig(),
    budget(),
    async () => malformed,
  );
  expect((await provider.generate(input, signal())).output).toEqual({});
});
test('Retry-After handles seconds, dates, invalid values and finite bounds', () => {
  expect(retryAfterMs('2')).toBe(2000);
  expect(retryAfterMs('Thu, 22 Oct 2026 00:00:03 GMT', Date.parse('2026-10-22T00:00:00Z'))).toBe(
    3000,
  );
  expect(retryAfterMs('invalid')).toBe(0);
  expect(retryAfterMs(null)).toBe(0);
  expect(retryAfterMs('9999999999')).toBe(604800000);
});
test('configuration rejects invalid flags, limits, paid prices and incompatible embedding spaces', () => {
  expect(() =>
    parseGeminiConfig({ GEMINI_API_KEY: 'secret!', GEMINI_REQUESTS_PER_DAY: '-1' }),
  ).toThrow('Invalid Gemini configuration:');
  expect(() => parseGeminiConfig({ GEMINI_FREE_TIER_CONFIRMED: 'yes' })).toThrow();
  expect(() => parseDraftConfig({ DRAFT_PROVIDER: 'gemini', DRAFT_MODEL: 'paid-model' })).toThrow();
  expect(() =>
    parseDraftConfig({
      DRAFT_PROVIDER: 'gemini',
      DRAFT_MODEL: 'gemini-2.5-flash-lite',
      DRAFT_OUTPUT_USD_PER_MILLION: '1',
    }),
  ).toThrow();
  expect(
    parseDraftConfig({ DRAFT_PROVIDER: 'gemini', DRAFT_MODEL: 'gemini-2.5-flash-lite' }).model,
  ).toBe('gemini-2.5-flash-lite');
  expect(() =>
    parseEmbeddingConfiguration({
      EMBEDDING_MODEL: 'gemini-embedding-2',
      EMBEDDING_DIMENSIONS: '768',
    }),
  ).toThrow();
});
