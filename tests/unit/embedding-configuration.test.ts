import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, parseEmbeddingConfiguration } from '@resolvehub/db';

test('embedding configuration is explicit and agrees with the implemented model and migrated vector type', () => {
  expect(parseEmbeddingConfiguration({})).toEqual({ EMBEDDING_MODEL, EMBEDDING_DIMENSIONS });
  expect(
    parseEmbeddingConfiguration({
      EMBEDDING_MODEL,
      EMBEDDING_DIMENSIONS: String(EMBEDDING_DIMENSIONS),
    }),
  ).toEqual({ EMBEDDING_MODEL, EMBEDDING_DIMENSIONS });
});
test.each([
  { EMBEDDING_DIMENSIONS: '1536' },
  { EMBEDDING_DIMENSIONS: 'NaN' },
  { EMBEDDING_MODEL: 'unimplemented-provider-model' },
])('changing dimensions/models requires a migration and implemented model', (input) => {
  expect(() => parseEmbeddingConfiguration(input)).toThrow('Invalid embedding configuration');
  try {
    parseEmbeddingConfiguration(input);
  } catch (error) {
    expect(String(error)).not.toContain('unimplemented-provider-model');
  }
});
