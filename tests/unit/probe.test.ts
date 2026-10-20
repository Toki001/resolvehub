import { randomUUID } from 'node:crypto';
import { processProbe } from '../../services/worker/src/probe.js';
import { MockDraftProvider } from '../../packages/ai/src/index.js';

test('operational probe preserves its correlation ID', () => {
  const requestId = randomUUID();
  expect(processProbe('health-probe', { requestId })).toEqual({
    requestId,
    processedAt: expect.any(String),
  });
});

test('worker refuses unregistered jobs or payloads with arbitrary fields', () => {
  expect(() => processProbe('index-document', { requestId: randomUUID() })).toThrow(
    'INVALID_SYSTEM_PROBE',
  );
  expect(() =>
    processProbe('health-probe', { requestId: randomUUID(), organizationId: 'unverified' }),
  ).toThrow('INVALID_SYSTEM_PROBE');
});

test('mock AI abstains without inventing citations', async () => {
  const provider = new MockDraftProvider();
  const result = await provider.draft({
    organizationId: randomUUID(),
    question: 'What is the policy?',
    evidence: [],
  });
  expect(result.kind).toBe('insufficient_evidence');
  expect(result.citations).toEqual([]);
});
