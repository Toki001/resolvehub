import { jest } from '@jest/globals';
import { discoverGeminiModels, GEMINI_MODEL } from '@resolvehub/ai';
import { geminiAccess } from '../helpers/gemini.js';

test('official SDK lists canonical models and generation methods without inferring free quota', async () => {
  const transport = jest.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      models: [
        {
          name: `models/${GEMINI_MODEL}`,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          description: 'Untrusted provider detail never forwarded',
        },
      ],
    }),
  );
  const result = await discoverGeminiModels(
    { ...geminiAccess(), verifiedModel: undefined },
    transport,
  );
  expect(result).toMatchObject({
    apiVersion: 'v1beta',
    requests: 1,
    totalListed: 1,
    models: [
      { name: `models/${GEMINI_MODEL}`, supportedActions: ['generateContent', 'countTokens'] },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('Untrusted');
  expect(result).not.toHaveProperty('freeQuota');
  expect(String(transport.mock.calls[0]?.[0])).toContain('/v1beta/models?pageSize=1000');
  expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
});

test('discovery is bounded to three metadata pages even when each page has a fresh continuation token', async () => {
  let page = 0;
  const transport = jest.fn<typeof fetch>().mockImplementation(async () => {
    page++;
    return Response.json({
      models: [{ name: `models/unrelated-${page}` }],
      nextPageToken: `page-${page + 1}`,
    });
  });
  await expect(discoverGeminiModels(geminiAccess(), transport)).rejects.toThrow(
    'GEMINI_DISCOVERY_',
  );
  expect(transport).toHaveBeenCalledTimes(3);
});

test('metadata discovery still requires current key-bound account verification', async () => {
  const transport = jest.fn<typeof fetch>();
  await expect(
    discoverGeminiModels({ ...geminiAccess(), billingDisabled: false }, transport),
  ).rejects.toThrow('GEMINI_FREE_TIER_UNVERIFIED');
  expect(transport).not.toHaveBeenCalled();
});
test('a candidate on the second metadata page is discovered with the same page-size bound', async () => {
  const transport = jest
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ models: [{ name: 'models/another-model' }], nextPageToken: 'next' }),
    )
    .mockResolvedValueOnce(
      Response.json({
        models: [
          { name: `models/${GEMINI_MODEL}`, supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );
  const result = await discoverGeminiModels(geminiAccess(), transport);
  expect(result.requests).toBe(2);
  expect(result.models[0]?.name).toBe(`models/${GEMINI_MODEL}`);
});

test.each([403, 404, 429, 500])(
  'discovery HTTP %i cannot leak provider details or trigger SDK retries',
  async (status) => {
    const transport = jest
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private-key-or-provider-detail', { status }));
    await expect(discoverGeminiModels(geminiAccess(), transport)).rejects.toThrow(
      'GEMINI_DISCOVERY_UNAVAILABLE',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

test('oversized model metadata is bounded and rejected', async () => {
  const transport = jest.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1048577)));
  await expect(discoverGeminiModels(geminiAccess(), transport)).rejects.toThrow(
    'GEMINI_DISCOVERY_',
  );
  expect(transport).toHaveBeenCalledTimes(1);
});

test('a metadata success without a body is unavailable rather than an empty available-model list', async () => {
  const transport = jest.fn<typeof fetch>().mockResolvedValue(new Response(null));
  await expect(discoverGeminiModels(geminiAccess(), transport)).rejects.toThrow(
    'GEMINI_DISCOVERY_UNAVAILABLE',
  );
  expect(transport).toHaveBeenCalledTimes(1);
});
