import { randomUUID } from 'node:crypto';
import { parse, getOperationAST } from 'graphql';
import { Pagination } from '../../services/api/src/application/pagination.js';
import { fingerprint, seal, unseal } from '../../services/api/src/auth/crypto.js';
import { checkQueryBudget } from '../../services/api/src/graphql/transport.js';

const secret = 'a'.repeat(64);
const pagination = new Pagination({ API_SECRET_KEY: secret });

test('cursors bind tenant, filters, query kind and authenticated bytes', () => {
  const organizationId = randomUUID();
  const row = { id: randomUUID(), createdAt: new Date().toISOString() };
  const window = pagination.window(organizationId, 'tickets', { status: 'open' }, 1);
  const cursor = window.connection([row], (node) => node.id).pageInfo.endCursor;
  expect(cursor).toBeTruthy();
  expect(
    pagination.window(organizationId, 'tickets', { status: 'open' }, 1, cursor).page.last?.id,
  ).toBe(row.id);
  expect(() => pagination.window(randomUUID(), 'tickets', { status: 'open' }, 1, cursor)).toThrow(
    'Cursor is invalid',
  );
  expect(() =>
    pagination.window(organizationId, 'tickets', { status: 'resolved' }, 1, cursor),
  ).toThrow('Cursor is invalid');
  expect(() =>
    pagination.window(organizationId, 'documents', { status: 'open' }, 1, cursor),
  ).toThrow('Cursor is invalid');
  expect(() =>
    pagination.window(organizationId, 'tickets', { status: 'open' }, 1, `x${cursor}`),
  ).toThrow('Cursor is invalid');
});

test('page sizes are bounded and empty connections have no cursor', () => {
  const org = randomUUID();
  expect(() => pagination.window(org, 'tickets', {}, 101)).toThrow();
  expect(() => pagination.window(org, 'tickets', {}, 0)).toThrow();
  expect(pagination.window(org, 'tickets', {}).connection([], () => '').pageInfo).toEqual({
    hasNextPage: false,
    endCursor: null,
  });
});

test('expired cursors cannot be reused', () => {
  const organizationId = randomUUID();
  const cursor = pagination
    .window(organizationId, 'tickets', {})
    .connection([{ id: randomUUID(), createdAt: new Date().toISOString() }], (row) => row.id)
    .pageInfo.endCursor;
  const future = Date.now() + 86_401_000;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(future);
  try {
    expect(() => pagination.window(organizationId, 'tickets', {}, 20, cursor)).toThrow(
      'Cursor is invalid',
    );
  } finally {
    clock.mockRestore();
  }
});

test('fingerprints normalize object ordering but preserve payload changes', () => {
  expect(fingerprint({ b: 2, a: { y: 1, x: 3 } })).toBe(fingerprint({ a: { x: 3, y: 1 }, b: 2 }));
  expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
});

test('secret encryption authenticates the integration-specific purpose', () => {
  const ciphertext = seal('private-signing-secret', secret, 'integration-a');
  expect(ciphertext).not.toContain('private-signing-secret');
  expect(unseal(ciphertext, secret, 'integration-a')).toBe('private-signing-secret');
  expect(() => unseal(ciphertext, secret, 'integration-b')).toThrow();
});

test('query budget counts variables, aliases and nested list expansion', () => {
  const document = parse(
    'query($first: Int!) { tickets(first: $first) { edges { node { messages { body } } } } }',
  );
  const operation = getOperationAST(document);
  if (!operation) throw new Error('Missing test operation');
  expect(() => checkQueryBudget(document, operation.selectionSet, { first: 100 })).toThrow(
    'cost exceeds',
  );
  expect(() => checkQueryBudget(document, operation.selectionSet, { first: 1 })).not.toThrow();
  expect(() => checkQueryBudget(document, operation.selectionSet, { first: 101 })).toThrow();
  const defaults = parse('query($first:Int=100){tickets(first:$first){edges{node{id}}}}');
  const defaultOperation = getOperationAST(defaults);
  if (!defaultOperation) throw new Error('Missing test operation');
  expect(() => checkQueryBudget(defaults, defaultOperation.selectionSet, {}, 250)).toThrow(
    'cost exceeds',
  );
  expect(() =>
    checkQueryBudget(defaults, defaultOperation.selectionSet, { first: 1 }, 250),
  ).not.toThrow();
});
