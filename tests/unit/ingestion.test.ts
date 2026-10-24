import {
  chunkText,
  normalizeText,
  extractText,
} from '../../services/worker/src/ingestion/extract.js';
import {
  bounded,
  retryDelay,
  IngestionFailure,
} from '../../services/worker/src/ingestion/failure.js';
import { syntheticEmbedding } from '@resolvehub/ai';
import { syntheticEmbedding as fixtureEmbedding } from '../../packages/db/seeds/fixtures.js';

test('chunking is bounded, deterministic, overlapping and preserves distinct evidence identifiers', () => {
  const text = 'A'.repeat(999) + 'B'.repeat(1200);
  const rows = chunkText(text, 'synthetic-version');
  expect(chunkText(text, 'synthetic-version')).toEqual(rows);
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.text.length <= 1000)).toBe(true);
  expect(rows[0]?.text.slice(-100)).toBe(rows[1]?.text.slice(0, 100));
  expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  expect(chunkText(text, 'another-version').map((row) => row.id)).not.toEqual(
    rows.map((row) => row.id),
  );
  expect(() => normalizeText('x'.repeat(200001))).toThrow('INVALID_CONTENT');
  expect(() => normalizeText('\0bad')).toThrow();
  expect(() => normalizeText('  ')).toThrow();
});
test('synthetic embeddings match the migrated fixture model exactly', () => {
  expect(syntheticEmbedding('same input')).toEqual(fixtureEmbedding('same input'));
  expect(syntheticEmbedding('same input')).toHaveLength(64);
});
test('retry delays grow exponentially, jitter within bounds and honor provider Retry-After', () => {
  expect([1, 2, 3].map((n) => retryDelay(n, 1000, () => 0))).toEqual([500, 1000, 2000]);
  expect(retryDelay(4, 1000, () => 1)).toBe(8000);
  expect(retryDelay(2, 1000, () => 0, 5000)).toBe(5000);
});
test('bounded provider calls abort hung implementations without waiting for them to cooperate', async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  await expect(
    bounded(
      async (input) => {
        signal = input;
        return new Promise<string>(() => undefined);
      },
      20,
      parent.signal,
    ),
  ).rejects.toMatchObject({ category: 'PROVIDER_TIMEOUT' });
  expect(signal?.aborted).toBe(true);
});
test('binary files cannot masquerade as plain text', async () => {
  const pdf = async () => 'Synthetic PDF';
  const signal = new AbortController().signal;
  expect(() => extractText(Buffer.from([255, 254]), 'text/plain', pdf, signal)).toThrow(
    IngestionFailure,
  );
  expect(() => extractText(Buffer.from('%PDF-1.0'), 'text/plain', pdf, signal)).toThrow(
    IngestionFailure,
  );
  expect(
    await extractText(Buffer.from('# Policy\r\nUseful text'), 'text/markdown', pdf, signal),
  ).toBe('# Policy\nUseful text');
});

test('unsupported media types are permanent failures before extraction', () => {
  expect(() =>
    extractText(
      Buffer.from('synthetic'),
      'application/zip',
      async () => 'unused',
      new AbortController().signal,
    ),
  ).toThrow('INVALID_TYPE');
});

test('pre-cancelled PDF extraction rejects before starting a parser thread', async () => {
  const { pdfExtractor } = await import('../../services/worker/src/ingestion/extract.js');
  const extract = pdfExtractor(new URL('file:///synthetic-unused-pdf-parser.js'));
  await expect(extract(Buffer.from('%PDF-1.7\n'), AbortSignal.abort())).rejects.toThrow(
    'EXTRACTION_TIMEOUT',
  );
});
