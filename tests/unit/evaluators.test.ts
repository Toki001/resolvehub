import { evaluateResults } from '../../packages/ai/evals/runner.js';
import { buildEvaluationFixtures } from '../../packages/ai/evals/fixtures.js';
import {
  DraftingPipeline,
  SyntheticEmbeddingProvider,
  ExtractiveMockProvider,
  draftConfigSchema,
} from '@resolvehub/ai';
import type { RagDraft } from '@resolvehub/ai';
const fixtures = buildEvaluationFixtures(),
  first = fixtures.cases[0];
if (!first) throw new Error('Missing golden case');
const cases = [first],
  corpus = fixtures.corpus;
const source = corpus.find((row) => row.chunkId === first.expectedEvidence[0]?.chunkId);
if (!source) throw new Error('Missing evidence');
const pipeline = new DraftingPipeline(
  new SyntheticEmbeddingProvider(),
  new ExtractiveMockProvider(),
  { search: async () => [{ ...source, distance: 0, lexicalRank: 1 }] },
  draftConfigSchema.parse({}),
);
const result = await pipeline.run(first);
test('metrics use actual identifiers and quotations, report denominators and descriptive intervals', () => {
  expect(evaluateResults(cases, corpus, [result])).toMatchObject({
    recallAt5: { numerator: 1, denominator: 1, value: 1, wilson95: { lower: expect.any(Number) } },
    supportedClaims: { numerator: 1, denominator: 1 },
    correctAbstention: { denominator: 0, value: null },
    failures: [],
  });
});
test.each([
  'unknown-citation',
  'fabricated-quote',
  'uncited-text',
  'foreign-context',
  'canary',
] as const)('evaluation rejects %s independently of generation self-reports', (kind) => {
  const draft: RagDraft = structuredClone(result);
  if (kind === 'unknown-citation')
    draft.citations = draft.citations.map((c) => ({ ...c, chunkId: first.organizationId }));
  if (kind === 'fabricated-quote')
    draft.citations = draft.citations.map((c) => ({ ...c, quote: 'Invented refund policy.' }));
  if (kind === 'uncited-text') draft.text += ' An invented customer promise.';
  if (kind === 'foreign-context')
    draft.trace.context = draft.trace.context.map((row) => ({
      ...row,
      text: 'Different private contents with forged source identifiers.',
    }));
  if (kind === 'canary') draft.text += ' BETA_PRIVATE_9M4';
  expect(evaluateResults(cases, corpus, [draft]).failures.length).toBeGreaterThan(0);
});
test('an always-abstaining generator cannot pass answer recall or support by having no claims', () => {
  const draft = {
    ...result,
    citations: [],
    generation: { ...result.generation, outcome: 'insufficient_evidence' as const },
    trace: { context: [], retrieved: [] },
  };
  expect(evaluateResults(cases, corpus, [draft])).toMatchObject({
    recallAt5: { value: 0 },
    supportedClaims: { value: null },
    answered: { value: 0 },
  });
  expect(() => evaluateResults(cases, corpus, [])).toThrow('count mismatch');
});
