import { jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createDatabase } from '@resolvehub/db';
import { createToken, tokenDigest } from '../../services/api/src/auth/crypto.js';
import { rest, schema, graph } from '../helpers/contracts.js';

jest.setTimeout(30000);
if (!process.env.DATABASE_URL || !process.env.S3_ENDPOINT)
  throw new Error('Local dependencies are required');
const pool = createDatabase(process.env.DATABASE_URL).pool;
const org = randomUUID(),
  foreign = randomUUID(),
  membership = randomUUID();
const admin = createToken(),
  agent = createToken(),
  other = createToken();
const bucket = process.env.S3_BUCKET ?? 'resolvehub';
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
const keys: string[] = [];
async function upload(text: string) {
  const bytes = Buffer.from(text),
    key = `organizations/${org}/uploads/${randomUUID()}`;
  keys.push(key);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'text/plain' }),
  );
  return {
    title: 'Synthetic HTTP ingestion',
    objectKey: key,
    mediaType: 'text/plain' as const,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function completed(jobId: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await rest('GET', '/v1/jobs/{id}', `/v1/jobs/${jobId}`, { token: admin });
    const job = schema('Job', result.body);
    if (['failed', 'succeeded'].includes(job.status)) return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Worker did not finish ingestion');
}
async function identity(token: string, organizationId: string, role: string, id = randomUUID()) {
  await pool.query('INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,$3,$4)', [
    id,
    organizationId,
    `${id}@example.test`,
    role,
  ]);
  await pool.query(
    "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [tokenDigest(token), organizationId, id],
  );
}
beforeAll(async () => {
  await pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,'Synthetic HTTP ingestion'),($2,'Synthetic foreign tenant')",
    [org, foreign],
  );
  await identity(admin, org, 'admin', membership);
  await identity(agent, org, 'agent');
  await identity(other, foreign, 'admin');
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)
      )
        throw error;
    }
  }
});
afterAll(async () => {
  try {
    for (const key of keys) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[org, foreign]]);
  } finally {
    s3.destroy();
    await pool.end();
  }
});

test('authenticated ingestion and revision requests publish real MinIO content; failed revisions keep the current search index', async () => {
  const input = await upload(
    'http-ingestion-scope: Approved refunds require payment verification.',
  );
  const key = randomUUID();
  const first = await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
    token: admin,
    key,
    body: input,
  });
  expect(first.response.status).toBe(202);
  const receipt = schema('AcceptedJob', first.body);
  const done = await completed(receipt.jobId);
  expect(done.status).toBe('succeeded');
  expect(
    (
      await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
        token: admin,
        key,
        body: input,
      })
    ).body,
  ).toEqual(first.body);
  const payload = await pool.query<{ payload: { documentId: string; versionId: string } }>(
    'SELECT payload FROM job_runs WHERE organization_id=$1 AND id=$2',
    [org, receipt.jobId],
  );
  const original = payload.rows[0]?.payload;
  if (!original) throw new Error('Missing ingestion identity');
  const revision = await upload(
    'http-ingestion-scope: An invalid replacement must never become searchable.',
  );
  const path = `/v1/documents/${original.documentId}/versions`;
  const revisionInput = {
    objectKey: revision.objectKey,
    mediaType: revision.mediaType,
    sizeBytes: revision.sizeBytes,
    sha256: revision.sha256,
  };
  expect(
    (
      await rest('POST', '/v1/documents/{id}/versions', path, {
        token: other,
        key: randomUUID(),
        body: { ...revisionInput, objectKey: `organizations/${foreign}/uploads/${randomUUID()}` },
      })
    ).response.status,
  ).toBe(404);
  const failed = await rest('POST', '/v1/documents/{id}/versions', path, {
    token: admin,
    key: randomUUID(),
    body: { ...revisionInput, sha256: '0'.repeat(64) },
  });
  expect(failed.response.status).toBe(202);
  const failedId = schema('AcceptedJob', failed.body).jobId;
  expect((await completed(failedId)).status).toBe('failed');
  const failure = await rest('GET', '/v1/jobs/{id}/failure', `/v1/jobs/${failedId}/failure`, {
    token: admin,
  });
  expect(schema('FailedJob', failure.body)).toMatchObject({
    errorCategory: 'HASH_MISMATCH',
    replayEligible: false,
  });
  expect(
    (
      await pool.query(
        'SELECT active_version_id FROM knowledge_documents WHERE organization_id=$1 AND id=$2',
        [org, original.documentId],
      )
    ).rows[0],
  ).toEqual({ active_version_id: original.versionId });
  const matches = await graph(
    admin,
    'query { knowledgeSearch(query:"http-ingestion-scope") { edges { node { documentId versionId excerpt } } } }',
  );
  expect(matches.body.errors).toBeUndefined();
  expect(JSON.stringify(matches.body.data)).toContain(original.versionId);
  expect(JSON.stringify(matches.body.data)).not.toContain('invalid replacement');
  const replacement = await upload(
    'http-ingestion-scope: The approved replacement has a five-day refund window.',
  );
  const accepted = await rest('POST', '/v1/documents/{id}/versions', path, {
    token: agent,
    key: randomUUID(),
    body: {
      objectKey: replacement.objectKey,
      mediaType: replacement.mediaType,
      sizeBytes: replacement.sizeBytes,
      sha256: replacement.sha256,
    },
  });
  expect((await completed(schema('AcceptedJob', accepted.body).jobId)).status).toBe('succeeded');
  expect(
    (
      await pool.query(
        'SELECT active_version_id FROM knowledge_documents WHERE organization_id=$1 AND id=$2',
        [org, original.documentId],
      )
    ).rows[0]?.active_version_id,
  ).not.toBe(original.versionId);
});

test('dead-letter inspection and manual replay require tenant identity; replay is admin-only, audited and idempotent', async () => {
  const input = await upload(
    'A synthetic recovered document is indexed after an authorized replay.',
  );
  const documentId = randomUUID(),
    versionId = randomUUID(),
    failedId = randomUUID(),
    requestId = randomUUID();
  await pool.query(
    "INSERT INTO knowledge_documents(id,organization_id,title,status) VALUES($1,$2,'Synthetic transient failure','failed')",
    [documentId, org],
  );
  await pool.query(
    "INSERT INTO document_versions(id,organization_id,document_id,object_key,media_type,size_bytes,sha256,status) VALUES($1,$2,$3,$4,'text/plain',$5,$6,'failed')",
    [versionId, org, documentId, input.objectKey, input.sizeBytes, input.sha256],
  );
  const payload = { documentId, versionId };
  await pool.query(
    "INSERT INTO job_runs(id,organization_id,kind,status,resource_id,payload,attempts,reason_code,request_id,requested_by) VALUES($1,$2,'document_ingestion','failed',$3,$4,4,'PROVIDER_TIMEOUT',$5,$6)",
    [failedId, org, documentId, JSON.stringify(payload), requestId, membership],
  );
  await pool.query(
    "INSERT INTO job_attempts(organization_id,job_id,attempt,stage,outcome,error_category,summary,finished_at) SELECT $1,$2,n,'embed','transient','PROVIDER_TIMEOUT','Synthetic timeout',now() FROM generate_series(1,4) n",
    [org, failedId],
  );
  await pool.query(
    "INSERT INTO failed_jobs(id,organization_id,job_id,error_category,summary,input_fingerprint,request_id,replay_eligible) VALUES($1,$2,$3,'PROVIDER_TIMEOUT','Synthetic timeout',$4,$5,true)",
    [
      randomUUID(),
      org,
      failedId,
      createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      requestId,
    ],
  );
  const detail = `/v1/jobs/${failedId}/failure`,
    path = `/v1/jobs/${failedId}/replay`;
  expect((await rest('GET', '/v1/jobs/{id}/failure', detail)).response.status).toBe(401);
  expect(
    (await rest('GET', '/v1/jobs/{id}/failure', detail, { token: other })).response.status,
  ).toBe(404);
  expect(
    (await rest('POST', '/v1/jobs/{id}/replay', path, { token: agent, key: randomUUID() })).response
      .status,
  ).toBe(403);
  expect(
    (await rest('POST', '/v1/jobs/{id}/replay', path, { token: other, key: randomUUID() })).response
      .status,
  ).toBe(404);
  const key = randomUUID();
  const replay = await rest('POST', '/v1/jobs/{id}/replay', path, { token: admin, key });
  expect(replay.response.status).toBe(202);
  expect((await rest('POST', '/v1/jobs/{id}/replay', path, { token: admin, key })).body).toEqual(
    replay.body,
  );
  expect(
    (await rest('POST', '/v1/jobs/{id}/replay', path, { token: admin, key: randomUUID() })).response
      .status,
  ).toBe(409);
  const replayId = schema('AcceptedJob', replay.body).jobId;
  expect((await completed(replayId)).status).toBe('succeeded');
  expect(
    schema(
      'FailedJob',
      (await rest('GET', '/v1/jobs/{id}/failure', detail, { token: admin })).body,
    ),
  ).toMatchObject({ replayEligible: false, replayedAs: replayId });
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='job.replayed'",
        [org, replayId],
      )
    ).rowCount,
  ).toBe(1);
});

test('1,000 outstanding ingestion documents reject excess requests with 429/Retry-After while existing receipts still replay', async () => {
  const input = await upload('Synthetic admission-control fixture.');
  const key = randomUUID();
  const accepted = await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
    token: admin,
    key,
    body: input,
  });
  expect(accepted.response.status).toBe(202);
  await pool.query(
    "INSERT INTO job_runs(id,organization_id,kind,status,payload,request_id,available_at,dispatch_after,reason_code) SELECT gen_random_uuid(),$1,'document_ingestion','processing',jsonb_build_object('documentId',gen_random_uuid(),'versionId',gen_random_uuid()),gen_random_uuid(),now()+interval '1 hour',now()+interval '1 hour','CAPACITY_TEST_ONLY' FROM generate_series(1,1000)",
    [org],
  );
  try {
    const rejected = await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
      token: admin,
      key: randomUUID(),
      body: input,
    });
    expect(rejected.response.status).toBe(429);
    expect(rejected.response.headers.get('retry-after')).toBe('30');
    expect(schema('Error', rejected.body).code).toBe('CAPACITY_EXCEEDED');
    expect(
      (
        await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
          token: admin,
          key,
          body: input,
        })
      ).body,
    ).toEqual(accepted.body);
  } finally {
    await pool.query(
      "DELETE FROM job_runs WHERE organization_id=$1 AND reason_code='CAPACITY_TEST_ONLY'",
      [org],
    );
  }
  expect((await completed(schema('AcceptedJob', accepted.body).jobId)).status).toBe('succeeded');
});
