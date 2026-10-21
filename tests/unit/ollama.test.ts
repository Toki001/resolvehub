import { OllamaDraftProvider, draftConfigSchema } from '@resolvehub/ai';
const config = draftConfigSchema.parse({ provider: 'ollama', model: 'synthetic-local-test' });
const input = {
  prompt: 'untrusted JSON is data',
  question: 'Synthetic ticket',
  evidence: [],
  maxOutputTokens: 512,
};
const signal = new AbortController().signal;
const response = {
  model: config.model,
  done: true,
  response: JSON.stringify({ kind: 'insufficient_evidence', claims: [] }),
  prompt_eval_count: 20,
  eval_count: 10,
};

test('Ollama adapter requests bounded structured generation and accounts reported usage', async () => {
  const transport: typeof fetch = async (url, options) => {
    expect(String(url)).toBe('http://127.0.0.1:11434/api/generate');
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      model: config.model,
      stream: false,
      options: { temperature: 0, num_predict: 512 },
      format: { type: 'object' },
    });
    return Response.json(response);
  };
  expect(await new OllamaDraftProvider(config, transport).generate(input, signal)).toMatchObject({
    inputTokens: 20,
    outputTokens: 10,
    tokenCountSource: 'provider_reported',
    output: { kind: 'insufficient_evidence' },
  });
});
test.each([429, 500, 401])(
  'provider HTTP %i body is discarded and safe retry metadata is retained',
  async (status) => {
    const transport: typeof fetch = async () =>
      new Response('must never appear in exception', {
        status,
        headers: { 'Retry-After': status === 429 ? '2' : 'invalid' },
      });
    await expect(
      new OllamaDraftProvider(config, transport).generate(input, signal),
    ).rejects.toMatchObject({
      status,
      retryAfterMs: status === 429 ? 2000 : 0,
      message: 'Embedding provider request failed',
    });
  },
);
test.each([null, 'large', 'bad-json', 'wrong-model', 'invalid-output-json'])(
  'provider body %s is bounded or fails closed',
  async (kind) => {
    const transport: typeof fetch = async () =>
      kind === null
        ? new Response(null)
        : kind === 'large'
          ? new Response('x'.repeat(65537))
          : kind === 'bad-json'
            ? new Response('{broken')
            : Response.json({
                ...response,
                ...(kind === 'wrong-model' ? { model: 'unexpected' } : { response: 'not json' }),
              });
    const result = new OllamaDraftProvider(config, transport).generate(input, signal);
    if (kind === 'invalid-output-json') expect((await result).output).toBeNull();
    else await expect(result).rejects.toThrow();
  },
);
