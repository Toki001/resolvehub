import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import { randomUUID } from 'node:crypto';
import { schema } from '../helpers/contracts.js';

test('canonical schemas reject tenant authority and undeclared mutation fields', () => {
  const input = {
    subject: 'Account access',
    customerEmail: 'synthetic@example.test',
    message: 'Please help.',
  };
  expect(schema('CreateTicketInput', input)).toEqual(input);
  expect(() => schema('CreateTicketInput', { ...input, organizationId: randomUUID() })).toThrow();
  expect(() => schema('CreateTicketInput', { ...input, customerEmail: 'invalid' })).toThrow();
  expect(() => schema('RejectDraftInput', { expectedRevision: 1, reason: '' })).toThrow();
  expect(() =>
    schema('IngestionInput', {
      title: 'Policy',
      objectKey: '../../another-tenant',
      mediaType: 'text/plain',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    }),
  ).toThrow();
});

test('SDL exposes authenticated reads and no tenant argument or GraphQL mutation', () => {
  const sdl = buildSchema(readFileSync('packages/contracts/schema.graphql', 'utf8'));
  expect(Object.keys(sdl.getQueryType()?.getFields() ?? {}).sort()).toEqual([
    'dashboardSummary',
    'draft',
    'knowledgeDocuments',
    'knowledgeSearch',
    'ticket',
    'tickets',
  ]);
  expect(sdl.getMutationType()).toBeUndefined();
  for (const field of Object.values(sdl.getQueryType()?.getFields() ?? {})) {
    expect(field.args.some((argument) => /tenant|organization/i.test(argument.name))).toBe(false);
  }
  const documents = parse(readFileSync('packages/contracts/operations/workspace.graphql', 'utf8'));
  expect(validate(sdl, documents)).toEqual([]);
  expect(
    validate(sdl, parse('{ tickets(organizationId:"forged") { pageInfo { hasNextPage } } }'))
      .length,
  ).toBeGreaterThan(0);
});
