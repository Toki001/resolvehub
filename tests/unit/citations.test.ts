import { ContractValidator } from '../../services/api/src/application/validator.js';

const validator = new ContractValidator();
const citation = {
  documentId: '10000000-0000-4000-8000-000000000001',
  versionId: '10000000-0000-4000-8000-000000000002',
  chunkId: '10000000-0000-4000-8000-000000000003',
};
test('canonical citation formatting preserves immutable document, version and chunk identifiers', () => {
  expect(validator.validate('Citation', JSON.parse(JSON.stringify(citation)), true)).toEqual(
    citation,
  );
});
test.each([
  { ...citation, chunkId: '[1]' },
  { ...citation, versionId: 'https://untrusted.example/source' },
  { ...citation, documentId: '<script>alert(1)</script>' },
  { documentId: citation.documentId, chunkId: citation.chunkId },
  { ...citation, label: 'invented' },
])('malformed citation references fail the response contract: %j', (input) => {
  expect(() => validator.validate('Citation', input, true)).toThrow(
    'Response violated its contract',
  );
});
