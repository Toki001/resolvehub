import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { DocumentStorage } from '../../services/worker/src/ingestion/storage.js';
import type { IngestionSource } from '@resolvehub/db';

const organizationId = '10000000-0000-4000-8000-000000000001';
const source: IngestionSource = {
  documentId: '10000000-0000-4000-8000-000000000002',
  versionId: '10000000-0000-4000-8000-000000000003',
  objectKey: `organizations/${organizationId}/uploads/10000000-0000-4000-8000-000000000004`,
  mediaType: 'text/plain',
  sizeBytes: 6,
  sha256: createHash('sha256').update('policy').digest('hex'),
  revision: 1,
  authorized: true,
};
const signal = new AbortController().signal;
function storage(result: { Body?: unknown; ContentType?: string; ContentLength?: number }) {
  return new DocumentStorage({ send: async () => result }, 'synthetic-test-bucket');
}
test('storage accepts validated bytes and always closes the object stream', async () => {
  const body = Readable.from([Buffer.from('policy')]);
  expect(
    await storage({ Body: body, ContentType: 'Text/Plain; charset=utf-8' }).fetch(
      source,
      organizationId,
      signal,
    ),
  ).toEqual(Buffer.from('policy'));
  expect(body.destroyed).toBe(true);
});
test.each([
  { objectKey: 'organizations/foreign/uploads/10000000-0000-4000-8000-000000000004' },
  { objectKey: `organizations/${organizationId}/uploads/../secret` },
  { mediaType: 'application/exe' },
  { sizeBytes: 0 },
  { sizeBytes: 10485761 },
])('invalid metadata is rejected before touching storage: %j', async (override) => {
  const client = {
    send: async () => {
      throw new Error('Must not fetch');
    },
  };
  await expect(
    new DocumentStorage(client, 'test').fetch({ ...source, ...override }, organizationId, signal),
  ).rejects.toMatchObject({ permanent: true });
});
test.each([
  [{ Body: undefined }, 'STORAGE_UNAVAILABLE'],
  [{ Body: Readable.from([Buffer.from('policy')]) }, 'INVALID_TYPE'],
  [
    { Body: Readable.from([Buffer.from('policy')]), ContentType: 'text/plain', ContentLength: 7 },
    'INVALID_SIZE',
  ],
  [
    { Body: Readable.from([Buffer.from('policy-extra')]), ContentType: 'text/plain' },
    'INVALID_SIZE',
  ],
  [{ Body: Readable.from([Buffer.from('short')]), ContentType: 'text/plain' }, 'INVALID_SIZE'],
  [{ Body: Readable.from(['policy']), ContentType: 'text/plain' }, 'INVALID_CONTENT'],
  [{ Body: Readable.from([Buffer.from('forged')]), ContentType: 'text/plain' }, 'HASH_MISMATCH'],
] as const)('object response %j fails safely with %s', async (result, category) => {
  await expect(storage(result).fetch(source, organizationId, signal)).rejects.toMatchObject({
    category,
  });
  if (result.Body instanceof Readable) expect(result.Body.destroyed).toBe(true);
});
test.each(['NoSuchKey', 'NotFound', 'NoSuchBucket'])(
  'missing object %s is a permanent failure',
  async (name) => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('private body'), { name });
      },
    };
    await expect(
      new DocumentStorage(client, 'test').fetch(source, organizationId, signal),
    ).rejects.toMatchObject({ category: 'OBJECT_NOT_FOUND', permanent: true });
  },
);
test.each([false, true])(
  'storage outages distinguish cancellation (%s) without leaking internals',
  async (aborted) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const client = {
      send: async () => {
        throw new Error('do not expose private provider body');
      },
    };
    await expect(
      new DocumentStorage(client, 'test').fetch(source, organizationId, controller.signal),
    ).rejects.toMatchObject({
      category: aborted ? 'STORAGE_TIMEOUT' : 'STORAGE_UNAVAILABLE',
      permanent: false,
    });
  },
);
