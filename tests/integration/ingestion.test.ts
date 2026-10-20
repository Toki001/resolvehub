import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { GenericContainer } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ContractStore, createDatabase, IngestionSession, migrate } from '@resolvehub/db';
import { SyntheticEmbeddingProvider } from '@resolvehub/ai';
import type { EmbeddingProvider } from '@resolvehub/ai';
import { INGESTION_QUEUE } from '@resolvehub/contracts';
import { ingestionProcessor } from '../../services/worker/src/ingestion/processor.js';
import { DocumentStorage } from '../../services/worker/src/ingestion/storage.js';
import { ProviderLimiter } from '../../services/worker/src/ingestion/limiter.js';
import { pdfExtractor } from '../../services/worker/src/ingestion/extract.js';
import {
  dispatchIngestions,
  ingestionQueue,
  ingestionBackoff,
} from '../../services/worker/src/ingestion/runtime.js';
import { schema } from '../helpers/contracts.js';

jest.setTimeout(90000);
// Every container is explicitly stopped in afterAll; no external Ryuk image is
// needed for this isolated suite on the local/CI Docker daemon.
process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
if (!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)
  throw new Error('Local PostgreSQL and MinIO are required');
const admin = createDatabase(process.env.DATABASE_URL).pool;
const namespace = `rh_ingest_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('options', `-c search_path=${namespace}`);
const pool = createDatabase(url.toString()).pool;
const store = new ContractStore(pool);
const organizationId = randomUUID(),
  member = randomUUID(),
  otherOrg = randomUUID();
const actor = {
  organizationId,
  actorId: member,
  actorKind: 'membership' as const,
  requestId: randomUUID(),
};
const bucket = `rh-ingest-${randomUUID()}`;
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? '',
  },
});
const storage = new DocumentStorage(s3, bucket);
const pdf = pdfExtractor(
  pathToFileURL(`${process.cwd()}/services/worker/dist/ingestion/pdf-parser.js`),
);
let container: StartedTestContainer | undefined, redisUrl: string;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await sleep(25);
  }
  throw new Error('Timed out waiting for authoritative job state');
}
async function job(id: string) {
  return schema('Job', await store.tenant(organizationId).job(id));
}
async function readyRedis(
  options: { maxRetriesPerRequest: number | null } = { maxRetriesPerRequest: 1 },
) {
  const redis = new Redis(redisUrl, {
    ...options,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    commandTimeout: 2000,
  });
  redis.on('error', () => undefined);
  try {
    await until(
      () =>
        redis
          .ping()
          .then(() => true)
          .catch(() => false),
      Boolean,
    );
  } catch (error) {
    redis.disconnect();
    throw error;
  }
  return redis;
}
async function createJob(
  text: string,
  options: {
    documentId?: string;
    bytes?: Buffer;
    mime?: string;
    contentType?: string;
    hash?: string;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from(text),
    objectKey = `organizations/${organizationId}/uploads/${randomUUID()}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: options.contentType ?? options.mime ?? 'text/plain',
    }),
  );
  let ids: { documentId: string; versionId: string } | undefined;
  const receipt = await store.mutate(
    actor,
    randomUUID(),
    'synthetic-ingestion',
    randomUUID(),
    async (repo) => {
      await repo.reserveIngestion();
      ids = await repo.createIngestion(
        {
          title: 'Synthetic processing test',
          objectKey,
          mediaType: options.mime ?? 'text/plain',
          sizeBytes: bytes.length,
          sha256: options.hash ?? createHash('sha256').update(bytes).digest('hex'),
        },
        options.documentId,
      );
      const id = await repo.createJob(
        'document_ingestion',
        ids.documentId,
        ids,
        actor.requestId,
        null,
        member,
      );
      return { status: 202, body: { id } };
    },
  );
  const jobId = schemaId(receipt.body);
  if (!ids) throw new Error('Missing fixture identity');
  return { ...ids, jobId, data: { organizationId, jobId } };
}
function schemaId(body: unknown) {
  if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string')
    throw new Error('Missing fixture receipt');
  return body.id;
}
async function active(documentId: string) {
  return (
    await pool.query<{ active_version_id: string | null }>(
      'SELECT active_version_id FROM knowledge_documents WHERE organization_id=$1 AND id=$2',
      [organizationId, documentId],
    )
  ).rows[0]?.active_version_id;
}
async function runWorker<T>(
  provider: EmbeddingProvider,
  action: (queue: ReturnType<typeof ingestionQueue>, producer: Redis) => Promise<T>,
) {
  const producer = await readyRedis(),
    consumer = await readyRedis({ maxRetriesPerRequest: null });
  const prefix = `case-${randomUUID()}`;
  const queue = ingestionQueue(producer, prefix);
  const process = ingestionProcessor({
    pool,
    provider,
    storage,
    limiter: new ProviderLimiter(producer, `${prefix}:provider`, 10),
    pdf,
    providerTimeoutMs: 40,
    retryBaseMs: 50,
  });
  const worker = new Worker(INGESTION_QUEUE, (job) => process(job.data), {
    connection: consumer,
    prefix,
    concurrency: 2,
    settings: { backoffStrategy: ingestionBackoff },
  });
  worker.on('error', () => undefined);
  queue.on('error', () => undefined);
  try {
    return await action(queue, producer);
  } finally {
    await worker.close();
    await queue.close();
    producer.disconnect();
    consumer.disconnect();
  }
}
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  await migrate(pool, pathToFileURL(`${process.cwd()}/packages/db/migrations/`));
  await pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,'Synthetic ingestion A'),($2,'Synthetic ingestion B')",
    [organizationId, otherOrg],
  );
  await pool.query(
    "INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,'synthetic@example.test','admin')",
    [member, organizationId],
  );
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  container = await new GenericContainer(
    'redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
  )
    .withExposedPorts(6379)
    .start();
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
}, 90000);
afterAll(async () => {
  try {
    const keys = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (keys.Contents?.length)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.Contents.flatMap((o) => (o.Key ? [{ Key: o.Key }] : [])) },
        }),
      );
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  } finally {
    s3.destroy();
    await container?.stop();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  }
});

test('real MinIO ingestion publishes one version despite concurrent duplicate BullMQ deliveries', async () => {
  const input = await createJob(
    'A synthetic refund policy supports verified duplicate-charge refunds.',
  );
  const delegate = new SyntheticEmbeddingProvider();
  const embed = jest.fn(async (texts: readonly string[], signal: AbortSignal) => {
    await sleep(20);
    return delegate.embed(texts, signal);
  });
  await runWorker(
    { ...delegate, model: delegate.model, dimensions: delegate.dimensions, embed },
    async (queue) => {
      await Promise.all([
        queue.add('indexDocument', input.data, { jobId: 'delivery-a' }),
        queue.add('indexDocument', input.data, { jobId: 'delivery-b' }),
        queue.add('indexDocument', input.data, { jobId: 'delivery-a' }),
      ]);
      expect(
        (
          await until(
            () => job(input.jobId),
            (j) => j.status === 'succeeded',
          )
        ).attempts,
      ).toBe(1);
    },
  );
  expect(await active(input.documentId)).toBe(input.versionId);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='document.indexed'",
        [organizationId, input.versionId],
      )
    ).rowCount,
  ).toBe(1);
  expect(await store.tenant(otherOrg).job(input.jobId)).toBeUndefined();
});

test('embedding timeouts exhaust exactly four attempts into durable DLQ, preserve the old publication and replay idempotently', async () => {
  const initial = await createJob(
    'The approved old refund policy stays live until the replacement succeeds.',
  );
  await runWorker(new SyntheticEmbeddingProvider(), async (queue) => {
    await queue.add('indexDocument', initial.data);
    await until(
      () => job(initial.jobId),
      (j) => j.status === 'succeeded',
    );
  });
  const replacement = await createJob(
    'The replacement refund policy has a revised five-day window.',
    { documentId: initial.documentId },
  );
  const provider = new SyntheticEmbeddingProvider();
  const embed = jest.fn(
    (_texts: readonly string[], _signal: AbortSignal) => new Promise<number[][]>(() => undefined),
  );
  await runWorker(
    { model: provider.model, dimensions: provider.dimensions, embed },
    async (queue) => {
      await queue.add('indexDocument', replacement.data);
      await until(
        () => job(replacement.jobId),
        (j) => j.status === 'failed',
      );
    },
  );
  expect(embed).toHaveBeenCalledTimes(4);
  expect(await active(initial.documentId)).toBe(initial.versionId);
  const failure = schema(
    'FailedJob',
    await store.tenant(organizationId).failure(replacement.jobId),
  );
  expect(failure.errorCategory).toBe('PROVIDER_TIMEOUT');
  expect(failure.attemptHistory.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
  expect(failure.replayEligible).toBe(true);
  const key = randomUUID();
  const replay = () =>
    store.mutate(actor, key, 'replay', replacement.jobId, async (repo) => ({
      status: 202,
      body: { id: await repo.replay(replacement.jobId, actor.requestId, member) },
    }));
  const receipt = await replay();
  expect(await replay()).toEqual(receipt);
  const replayId = schemaId(receipt.body);
  const fetch = jest.spyOn(storage, 'fetch');
  try {
    await runWorker(provider, async (queue) => {
      await queue.add('indexDocument', { organizationId, jobId: replayId });
      await until(
        () => job(replayId),
        (j) => j.status === 'succeeded',
      );
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
  expect(await active(initial.documentId)).toBe(replacement.versionId);
  expect((await job(replacement.jobId)).status).toBe('failed');
  expect(
    schema('FailedJob', await store.tenant(organizationId).failure(replacement.jobId)),
  ).toMatchObject({ replayEligible: false, replayedAs: replayId });
});

test.each([
  { hash: '0'.repeat(64), category: 'HASH_MISMATCH' },
  { contentType: 'application/octet-stream', category: 'INVALID_TYPE' },
  { mime: 'application/pdf', category: 'INVALID_CONTENT' },
  { bytes: Buffer.from([255, 254]), category: 'INVALID_CONTENT' },
])('invalid files are permanent on the first attempt: $category', async (options) => {
  const input = await createJob('Synthetic invalid file', options);
  const redis = await readyRedis();
  try {
    const process = ingestionProcessor({
      pool,
      provider: new SyntheticEmbeddingProvider(),
      storage,
      limiter: new ProviderLimiter(redis, 'invalid-provider', 10),
      pdf,
    });
    await expect(process(input.data)).rejects.toThrow(options.category);
    const failure = schema('FailedJob', await store.tenant(organizationId).failure(input.jobId));
    expect(failure.replayEligible).toBe(false);
    expect(failure.attemptHistory).toHaveLength(1);
    expect((await job(input.jobId)).attempts).toBe(1);
  } finally {
    redis.disconnect();
  }
});

test('a mid-batch PostgreSQL failure rolls back embeddings and retries from extraction without changing the active index', async () => {
  const initial = await createJob('Original policy remains published.');
  await runWorker(new SyntheticEmbeddingProvider(), async (queue) => {
    await queue.add('indexDocument', initial.data);
    await until(
      () => job(initial.jobId),
      (j) => j.status === 'succeeded',
    );
  });
  const input = await createJob('Replacement text '.repeat(150), {
    documentId: initial.documentId,
  });
  const redis = await readyRedis();
  const process = ingestionProcessor({
    pool,
    provider: new SyntheticEmbeddingProvider(),
    storage,
    limiter: new ProviderLimiter(redis, 'partial-provider', 10),
    pdf,
    retryBaseMs: 10,
  });
  const fetch = jest.spyOn(storage, 'fetch');
  try {
    await pool.query(
      `CREATE FUNCTION reject_embedding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version_id='${input.versionId}'::uuid AND NEW.ordinal=1 AND NEW.embedding IS NOT NULL THEN RAISE EXCEPTION 'Synthetic write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_embedding BEFORE UPDATE ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION reject_embedding();`,
    );
    await expect(process(input.data)).rejects.toThrow('Ingestion attempt requires retry');
    expect(
      (
        await pool.query(
          'SELECT id FROM knowledge_chunks WHERE organization_id=$1 AND version_id=$2 AND embedding IS NOT NULL',
          [organizationId, input.versionId],
        )
      ).rowCount,
    ).toBe(0);
    expect(await active(initial.documentId)).toBe(initial.versionId);
    await pool.query('DROP TRIGGER reject_embedding ON knowledge_chunks');
    await pool.query('DROP FUNCTION reject_embedding()');
    await pool.query('UPDATE job_runs SET available_at=now() WHERE organization_id=$1 AND id=$2', [
      organizationId,
      input.jobId,
    ]);
    await process(input.data);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await job(input.jobId)).attempts).toBe(2);
    expect(await active(initial.documentId)).toBe(input.versionId);
  } finally {
    fetch.mockRestore();
    redis.disconnect();
    await pool.query('DROP TRIGGER IF EXISTS reject_embedding ON knowledge_chunks');
    await pool.query('DROP FUNCTION IF EXISTS reject_embedding()');
  }
});

test('a disconnected Redis producer loses no accepted handoff; dispatch recovers after reconnect and server restart', async () => {
  const input = await createJob('Redis recovery retains this accepted document.');
  const producer = await readyRedis();
  const queue = ingestionQueue(producer, `disconnect-${randomUUID()}`);
  queue.on('error', () => undefined);
  try {
    await queue.waitUntilReady();
    producer.disconnect();
    await expect(dispatchIngestions(pool, queue)).rejects.toThrow();
    expect(await job(input.jobId)).toMatchObject({ status: 'accepted', attempts: 0 });
  } finally {
    await queue.close();
    producer.disconnect();
  }
  if (!container) throw new Error('Missing isolated Redis');
  await container.restart();
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  await runWorker(new SyntheticEmbeddingProvider(), async (queue) => {
    await dispatchIngestions(pool, queue);
    expect(
      (
        await until(
          () => job(input.jobId),
          (j) => j.status === 'succeeded',
        )
      ).attempts,
    ).toBe(1);
  });
});

test('interrupted claims consume the durable attempt budget and resume under a new version lock', async () => {
  const input = await createJob('Worker interruption recovers under a new claim.');
  const session = await IngestionSession.open(pool, organizationId, input.jobId);
  if (!session) throw new Error('Missing claim');
  expect(await session.claim()).toBe('run');
  await session.close();
  await pool.query(
    'UPDATE job_runs SET available_at=now(),dispatch_after=now() WHERE organization_id=$1 AND id=$2',
    [organizationId, input.jobId],
  );
  await runWorker(new SyntheticEmbeddingProvider(), async (queue) => {
    await dispatchIngestions(pool, queue);
    await until(
      () => job(input.jobId),
      (j) => j.status === 'succeeded',
    );
  });
  const history = await pool.query(
    'SELECT outcome FROM job_attempts WHERE organization_id=$1 AND job_id=$2 ORDER BY attempt',
    [organizationId, input.jobId],
  );
  expect(history.rows).toEqual([{ outcome: 'abandoned' }, { outcome: 'succeeded' }]);
});

test('provider rate limiting is shared across connections and cancellation stops a waiting caller', async () => {
  const one = await readyRedis(),
    two = await readyRedis();
  const key = `rate-${randomUUID()}`;
  const a = new ProviderLimiter(one, key, 1, 120),
    b = new ProviderLimiter(two, key, 1, 120);
  const signal = new AbortController();
  try {
    const started = Date.now();
    await Promise.all([a.acquire(signal.signal), b.acquire(signal.signal)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    const controller = new AbortController();
    const waiting = a.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('WORKER_INTERRUPTED');
  } finally {
    one.disconnect();
    two.disconnect();
  }
});

test('a real PDF is extracted in a bounded worker thread and indexed', async () => {
  const content = 'BT /F1 12 Tf 72 720 Td (Synthetic PDF refunds require verification.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let document = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(document));
    document += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(document);
  document += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
    .join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const input = await createJob('', { bytes: Buffer.from(document), mime: 'application/pdf' });
  await runWorker(new SyntheticEmbeddingProvider(), async (queue) => {
    await queue.add('indexDocument', input.data);
    await until(
      () => job(input.jobId),
      (j) => j.status === 'succeeded',
    );
  });
  const rows = await pool.query<{ text: string }>(
    'SELECT text FROM knowledge_chunks WHERE organization_id=$1 AND version_id=$2',
    [organizationId, input.versionId],
  );
  expect(rows.rows[0]?.text).toContain('Synthetic PDF refunds require verification.');
  const developmentExtract = pdfExtractor(
    pathToFileURL(`${process.cwd()}/services/worker/src/ingestion/pdf-parser.ts`),
  );
  expect(await developmentExtract(Buffer.from(document), new AbortController().signal)).toContain(
    'Synthetic PDF refunds require verification.',
  );
});

test('database admission serializes concurrent requests at the 1,000-document boundary', async () => {
  const ids: string[] = [];
  try {
    const added = await pool.query<{ id: string }>(
      "INSERT INTO job_runs(id,organization_id,kind,status,payload,request_id,available_at,dispatch_after) SELECT gen_random_uuid(),$1,'document_ingestion','accepted',jsonb_build_object('documentId',gen_random_uuid(),'versionId',gen_random_uuid()),gen_random_uuid(),now()+interval '1 hour',now()+interval '1 hour' FROM generate_series(1,999) RETURNING id",
      [organizationId],
    );
    ids.push(...added.rows.map((row) => row.id));
    const requests = await Promise.allSettled(
      [0, 1].map(() =>
        store.mutate(actor, randomUUID(), 'admission-race', randomUUID(), async (repo) => {
          await repo.reserveIngestion();
          const id = await repo.createJob(
            'document_ingestion',
            null,
            { documentId: randomUUID(), versionId: randomUUID() },
            actor.requestId,
            null,
            member,
          );
          ids.push(id);
          return { status: 202, body: { id } };
        }),
      ),
    );
    expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(requests.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT ingestion_pending_count() count')).rows[0]).toEqual({
      count: 1000,
    });
  } finally {
    await pool.query('DELETE FROM job_runs WHERE organization_id=$1 AND id=ANY($2::uuid[])', [
      organizationId,
      ids,
    ]);
  }
});

test('the non-owner worker grants support global dispatch and scoped indexing without global table access', async () => {
  const role = `rh_worker_${randomUUID().replaceAll('-', '')}`;
  const grants = (await readFile('infra/docker/worker-grants.sql', 'utf8')).replaceAll(
    'resolvehub_worker',
    role,
  );
  const runtimeUrl = new URL(url.toString());
  runtimeUrl.searchParams.set('options', `-c search_path=${namespace} -c role=${role}`);
  const runtime = createDatabase(runtimeUrl.toString()).pool;
  const input = await createJob('A scoped worker indexes this synthetic policy.');
  const redis = await readyRedis();
  const queue = ingestionQueue(redis, `role-${randomUUID()}`);
  queue.on('error', () => undefined);
  try {
    await pool.query(grants);
    expect((await runtime.query('SELECT id FROM job_runs')).rowCount).toBe(0);
    await dispatchIngestions(runtime, queue);
    const processor = ingestionProcessor({
      pool: runtime,
      provider: new SyntheticEmbeddingProvider(),
      storage,
      limiter: new ProviderLimiter(redis, 'role-provider', 10),
      pdf,
    });
    await processor(input.data);
    expect((await job(input.jobId)).status).toBe('succeeded');
    expect((await runtime.query('SELECT id FROM knowledge_chunks')).rowCount).toBe(0);
  } finally {
    await queue.close();
    redis.disconnect();
    await runtime.end();
    await pool.query(`DROP OWNED BY "${role}"`);
    await pool.query(`DROP ROLE "${role}"`);
  }
});

test('workers reload membership authority and do not fetch content after authorization is revoked', async () => {
  const input = await createJob('Revoked membership cannot index this content.');
  const redis = await readyRedis();
  const fetch = jest.spyOn(storage, 'fetch');
  try {
    await pool.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND id=$2', [
      organizationId,
      member,
    ]);
    const processor = ingestionProcessor({
      pool,
      provider: new SyntheticEmbeddingProvider(),
      storage,
      limiter: new ProviderLimiter(redis, 'revoked-provider', 10),
      pdf,
    });
    await expect(processor(input.data)).rejects.toThrow('AUTHORIZATION_REVOKED');
    expect(fetch).not.toHaveBeenCalled();
    expect(
      schema('FailedJob', await store.tenant(organizationId).failure(input.jobId)).replayEligible,
    ).toBe(false);
  } finally {
    await pool.query('UPDATE memberships SET active=true WHERE organization_id=$1 AND id=$2', [
      organizationId,
      member,
    ]);
    fetch.mockRestore();
    redis.disconnect();
  }
});

test('four interrupted attempts reach DLQ without a fifth execution even after a fresh delivery', async () => {
  const input = await createJob(
    'The retry budget survives worker interruptions and Redis state loss.',
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    await pool.query('UPDATE job_runs SET available_at=now() WHERE organization_id=$1 AND id=$2', [
      organizationId,
      input.jobId,
    ]);
    const session = await IngestionSession.open(pool, organizationId, input.jobId);
    if (!session) throw new Error('Missing claim');
    expect(await session.claim()).toBe('run');
    await session.close();
  }
  await pool.query('UPDATE job_runs SET available_at=now() WHERE organization_id=$1 AND id=$2', [
    organizationId,
    input.jobId,
  ]);
  const redis = await readyRedis(),
    fetch = jest.spyOn(storage, 'fetch');
  try {
    const processor = ingestionProcessor({
      pool,
      provider: new SyntheticEmbeddingProvider(),
      storage,
      limiter: new ProviderLimiter(redis, 'interrupted-provider', 10),
      pdf,
    });
    await expect(processor(input.data)).rejects.toThrow('WORKER_INTERRUPTED');
    expect(fetch).not.toHaveBeenCalled();
    const failure = schema('FailedJob', await store.tenant(organizationId).failure(input.jobId));
    expect(failure.attemptHistory).toHaveLength(4);
    expect(failure.attemptHistory.every((a) => a.outcome === 'abandoned')).toBe(true);
    expect((await job(input.jobId)).attempts).toBe(4);
  } finally {
    fetch.mockRestore();
    redis.disconnect();
  }
});

test('publication and job completion roll back together if the final audit write fails', async () => {
  const initial = await createJob('Previously approved publication.');
  await runWorker(new SyntheticEmbeddingProvider(), async (queue) => {
    await queue.add('indexDocument', initial.data);
    await until(
      () => job(initial.jobId),
      (j) => j.status === 'succeeded',
    );
  });
  const input = await createJob('Fully embedded replacement must wait for an atomic publication.', {
    documentId: initial.documentId,
  });
  const redis = await readyRedis();
  const provider = new SyntheticEmbeddingProvider(),
    embed = jest.spyOn(provider, 'embed'),
    fetch = jest.spyOn(storage, 'fetch');
  const processor = ingestionProcessor({
    pool,
    provider,
    storage,
    limiter: new ProviderLimiter(redis, 'atomic-provider', 10),
    pdf,
    retryBaseMs: 10,
  });
  try {
    await pool.query(
      `CREATE FUNCTION reject_index_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.resource_id='${input.versionId}'::uuid AND NEW.action='document.indexed' THEN RAISE EXCEPTION 'Synthetic publication failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_index_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_index_audit();`,
    );
    await expect(processor(input.data)).rejects.toThrow('Ingestion attempt requires retry');
    expect(await active(initial.documentId)).toBe(initial.versionId);
    expect((await job(input.jobId)).status).toBe('accepted');
    expect(
      (
        await pool.query(
          'SELECT status FROM document_versions WHERE organization_id=$1 AND id=$2',
          [organizationId, initial.versionId],
        )
      ).rows[0],
    ).toEqual({ status: 'indexed' });
    await pool.query('DROP TRIGGER reject_index_audit ON audit_events');
    await pool.query('DROP FUNCTION reject_index_audit()');
    await pool.query('UPDATE job_runs SET available_at=now() WHERE organization_id=$1 AND id=$2', [
      organizationId,
      input.jobId,
    ]);
    await processor(input.data);
    expect(await active(initial.documentId)).toBe(input.versionId);
    expect((await job(input.jobId)).status).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
    embed.mockRestore();
    redis.disconnect();
    await pool.query('DROP TRIGGER IF EXISTS reject_index_audit ON audit_events');
    await pool.query('DROP FUNCTION IF EXISTS reject_index_audit()');
  }
});

test('a Redis loss during embedding admission retries from the persisted chunk checkpoint', async () => {
  const input = await createJob('A Redis outage after extraction must retain the staged index.');
  const redis = await readyRedis();
  const fetch = jest.spyOn(storage, 'fetch');
  try {
    const limiter = new ProviderLimiter(redis, 'midflight-provider', 10);
    const processor = ingestionProcessor({
      pool,
      provider: new SyntheticEmbeddingProvider(),
      storage,
      limiter: {
        acquire: async (signal) => {
          redis.disconnect();
          await limiter.acquire(signal);
        },
      },
      pdf,
      retryBaseMs: 10,
    });
    await expect(processor(input.data)).rejects.toThrow('Ingestion attempt requires retry');
    expect(await job(input.jobId)).toMatchObject({
      status: 'accepted',
      attempts: 1,
      reasonCode: 'REDIS_UNAVAILABLE',
    });
    expect(await active(input.documentId)).toBeNull();
    await redis.connect();
    await pool.query('UPDATE job_runs SET available_at=now() WHERE organization_id=$1 AND id=$2', [
      organizationId,
      input.jobId,
    ]);
    const resumed = ingestionProcessor({
      pool,
      provider: new SyntheticEmbeddingProvider(),
      storage,
      limiter,
      pdf,
    });
    await resumed(input.data);
    expect((await job(input.jobId)).status).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
    redis.disconnect();
  }
});
