import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { print } from 'graphql';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { createDatabase } from '@resolvehub/db';
import { createToken, tokenDigest } from '../../services/api/src/auth/crypto.js';
import {
  ReviewQueueDocument,
  WorkspaceTicketDocument,
  BackgroundJobsDocument,
} from '@resolvehub/generated';
import { rest, graph, schema, apiUrl } from '../helpers/contracts.js';

if (!process.env.DATABASE_URL) throw new Error('Use the isolated integration runner');
const pool = createDatabase(process.env.DATABASE_URL).pool;
const organization = randomUUID(),
  foreign = randomUUID(),
  ticketId = randomUUID(),
  documentId = randomUUID(),
  versionId = randomUUID(),
  chunkId = randomUUID();
const token = createToken(),
  foreignToken = createToken(),
  analyst = createToken(),
  membership = randomUUID();
async function credential(org: string, key: string, role: string, id = randomUUID()) {
  await pool.query('INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,$3,$4)', [
    id,
    org,
    `${id}@example.test`,
    role,
  ]);
  await pool.query(
    "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [tokenDigest(key), org, id],
  );
}
async function draft(text = 'The refund window is 14 days after payment.') {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO draft_responses(id,organization_id,ticket_id,text,evidence_validated,model,prompt_version) VALUES($1,$2,$3,$4,true,'test-fixture','test-v1')",
    [id, organization, ticketId, text],
  );
  await pool.query(
    'INSERT INTO citations(id,organization_id,draft_id,document_id,version_id,chunk_id,position,quote) VALUES($1,$2,$3,$4,$5,$6,0,$7)',
    [
      randomUUID(),
      organization,
      id,
      documentId,
      versionId,
      chunkId,
      'The refund window is 14 days after payment.',
    ],
  );
  return id;
}
beforeAll(async () => {
  await pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,'Internal workflow A'),($2,'Internal workflow B')",
    [organization, foreign],
  );
  await credential(organization, token, 'admin', membership);
  await credential(foreign, foreignToken, 'admin');
  await credential(organization, analyst, 'analyst');
  await pool.query(
    "INSERT INTO tickets(id,organization_id,subject,customer_email) VALUES($1,$2,'Refund window','synthetic@example.test')",
    [ticketId, organization],
  );
  await pool.query(
    "INSERT INTO knowledge_documents(id,organization_id,title,status) VALUES($1,$2,'Synthetic refund policy','indexed')",
    [documentId, organization],
  );
  await pool.query(
    "INSERT INTO document_versions(id,organization_id,document_id,object_key,media_type,size_bytes,sha256,status) VALUES($1,$2,$3,$4,'text/plain',42,$5,'indexed')",
    [
      versionId,
      organization,
      documentId,
      `organizations/${organization}/uploads/${randomUUID()}`,
      'a'.repeat(64),
    ],
  );
  await pool.query(
    "INSERT INTO knowledge_chunks(id,organization_id,document_id,version_id,text) VALUES($1,$2,$3,$4,'The refund window is 14 days after payment.')",
    [chunkId, organization, documentId, versionId],
  );
  await pool.query(
    'UPDATE knowledge_documents SET active_version_id=$3 WHERE organization_id=$1 AND id=$2',
    [organization, documentId, versionId],
  );
});
afterAll(async () => {
  await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[organization, foreign]]);
  await pool.end();
});
const mutate = (template: string, url: string, body: unknown, key = randomUUID(), bearer = token) =>
  rest('POST', template, url, { token: bearer, key, body });

test('editing is revision controlled; approval records exactly one internal message with explicit human acknowledgement', async () => {
  const id = await draft(),
    edited = 'Thanks for contacting us. The refund window is 14 days after payment. [1]';
  const key = randomUUID();
  const result = await mutate(
    '/v1/drafts/{id}/edits',
    `/v1/drafts/${id}/edits`,
    { expectedRevision: 1, text: edited },
    key,
  );
  expect(result.response.status).toBe(200);
  expect(schema('Draft', result.body)).toMatchObject({
    text: edited,
    originalText: 'The refund window is 14 days after payment.',
    humanEdited: true,
    editedBy: membership,
    revision: 2,
  });
  expect(
    (
      await mutate(
        '/v1/drafts/{id}/edits',
        `/v1/drafts/${id}/edits`,
        { expectedRevision: 1, text: edited },
        key,
      )
    ).body,
  ).toEqual(result.body);
  expect(
    (
      await mutate('/v1/drafts/{id}/edits', `/v1/drafts/${id}/edits`, {
        expectedRevision: 1,
        text: 'Stale',
      })
    ).response.status,
  ).toBe(409);
  expect(
    (await mutate('/v1/drafts/{id}/approve', `/v1/drafts/${id}/approve`, { expectedRevision: 2 }))
      .response.status,
  ).toBe(422);
  const approvalKey = randomUUID();
  const approved = await mutate(
    '/v1/drafts/{id}/approve',
    `/v1/drafts/${id}/approve`,
    { expectedRevision: 2, acknowledgeEdits: true },
    approvalKey,
  );
  expect(approved.response.status).toBe(200);
  expect(
    (
      await mutate(
        '/v1/drafts/{id}/approve',
        `/v1/drafts/${id}/approve`,
        { expectedRevision: 2, acknowledgeEdits: true },
        approvalKey,
      )
    ).body,
  ).toEqual(approved.body);
  expect(
    (
      await mutate('/v1/drafts/{id}/edits', `/v1/drafts/${id}/edits`, {
        expectedRevision: 3,
        text: 'After approval',
      })
    ).response.status,
  ).toBe(409);
  const messages = await pool.query<{
    body: string;
    delivery_status: string;
    source_draft_id: string;
  }>(
    'SELECT body,delivery_status,source_draft_id FROM ticket_messages WHERE organization_id=$1 AND source_draft_id=$2',
    [organization, id],
  );
  expect(messages.rows).toEqual([
    { body: edited, delivery_status: 'internal', source_draft_id: id },
  ]);
});
test('concurrent approvals converge on one internal message; rejection never records a reply', async () => {
  const id = await draft();
  const results = await Promise.all(
    [1, 2].map(() =>
      mutate('/v1/drafts/{id}/approve', `/v1/drafts/${id}/approve`, { expectedRevision: 1 }),
    ),
  );
  expect(results.map((r) => r.response.status).sort()).toEqual([200, 409]);
  expect(
    (
      await pool.query(
        'SELECT id FROM ticket_messages WHERE organization_id=$1 AND source_draft_id=$2',
        [organization, id],
      )
    ).rowCount,
  ).toBe(1);
  const rejected = await draft();
  const result = await mutate('/v1/drafts/{id}/reject', `/v1/drafts/${rejected}/reject`, {
    expectedRevision: 1,
    reason: 'Needs a clearer explanation.',
  });
  expect(schema('Draft', result.body).reviewReason).toBe('Needs a clearer explanation.');
  expect(
    (
      await pool.query(
        'SELECT id FROM ticket_messages WHERE organization_id=$1 AND source_draft_id=$2',
        [organization, rejected],
      )
    ).rowCount,
  ).toBe(0);
});
test('message insertion failure rolls back approval, audit and idempotency receipt; the same command can be retried', async () => {
  const id = await draft(),
    key = randomUUID(),
    suffix = randomUUID().replaceAll('-', '');
  const trigger = `reply_failure_${suffix}`;
  try {
    await pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_draft_id='${id}'::uuid THEN RAISE EXCEPTION 'synthetic transaction failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON ticket_messages FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    expect(
      (
        await mutate(
          '/v1/drafts/{id}/approve',
          `/v1/drafts/${id}/approve`,
          { expectedRevision: 1 },
          key,
        )
      ).response.status,
    ).toBe(503);
    expect(
      (
        await pool.query<{ status: string; revision: number }>(
          'SELECT status,revision FROM draft_responses WHERE organization_id=$1 AND id=$2',
          [organization, id],
        )
      ).rows[0],
    ).toEqual({ status: 'pending', revision: 1 });
    expect(
      (
        await pool.query(
          'SELECT key FROM idempotency_records WHERE organization_id=$1 AND key=$2',
          [organization, key],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT id FROM audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='draft.approved'",
          [organization, id],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await pool.query(
      `DROP TRIGGER IF EXISTS ${trigger} ON ticket_messages; DROP FUNCTION IF EXISTS ${trigger}()`,
    );
  }
  expect(
    (
      await mutate(
        '/v1/drafts/{id}/approve',
        `/v1/drafts/${id}/approve`,
        { expectedRevision: 1 },
        key,
      )
    ).response.status,
  ).toBe(200);
});
test('tenant and analyst boundaries protect edits, messages and ticket status; transitions reject stale state', async () => {
  const id = await draft();
  for (const [bearer, status] of [
    [foreignToken, 404],
    [analyst, 403],
  ] as const) {
    expect(
      (
        await mutate(
          '/v1/drafts/{id}/edits',
          `/v1/drafts/${id}/edits`,
          { expectedRevision: 1, text: 'Unauthorized' },
          randomUUID(),
          bearer,
        )
      ).response.status,
    ).toBe(status);
    expect(
      (
        await mutate(
          '/v1/tickets/{id}/messages',
          `/v1/tickets/${ticketId}/messages`,
          { body: 'Unauthorized' },
          randomUUID(),
          bearer,
        )
      ).response.status,
    ).toBe(status);
    expect(
      (
        await mutate(
          '/v1/tickets/{id}/status',
          `/v1/tickets/${ticketId}/status`,
          { expectedStatus: 'open', event: 'resolve' },
          randomUUID(),
          bearer,
        )
      ).response.status,
    ).toBe(status);
  }
  expect(
    (
      await mutate('/v1/tickets/{id}/status', `/v1/tickets/${ticketId}/status`, {
        expectedStatus: 'open',
        event: 'resolve',
      })
    ).response.status,
  ).toBe(200);
  expect(
    (
      await mutate('/v1/tickets/{id}/status', `/v1/tickets/${ticketId}/status`, {
        expectedStatus: 'open',
        event: 'wait',
      })
    ).response.status,
  ).toBe(409);
  expect(
    (
      await mutate('/v1/tickets/{id}/status', `/v1/tickets/${ticketId}/status`, {
        expectedStatus: 'resolved',
        event: 'wait',
      })
    ).response.status,
  ).toBe(409);
  expect(
    (
      await mutate('/v1/tickets/{id}/status', `/v1/tickets/${ticketId}/status`, {
        expectedStatus: 'resolved',
        event: 'reopen',
      })
    ).response.status,
  ).toBe(200);
  const message = await mutate('/v1/tickets/{id}/messages', `/v1/tickets/${ticketId}/messages`, {
    body: 'Additional customer context.',
  });
  expect(schema('Message', message.body)).toMatchObject({
    author: 'customer',
    deliveryStatus: 'received',
    sourceDraftId: null,
  });
});
test('review and complete message history use bounded tenant-bound cursors; background jobs are scoped', async () => {
  await draft();
  await draft();
  for (let i = 0; i < 105; i++)
    await pool.query(
      "INSERT INTO ticket_messages(id,organization_id,ticket_id,body,author,created_at) VALUES($1,$2,$3,$4,'customer','2026-01-01')",
      [randomUUID(), organization, ticketId, `Synthetic history ${i}`],
    );
  let after: string | null = null;
  const ids: string[] = [];
  do {
    const result = await graph(token, print(WorkspaceTicketDocument), {
      id: ticketId,
      messagesAfter: after,
    });
    expect(result.body.errors).toBeUndefined();
    const history = z
      .object({
        ticket: z.object({
          messageHistory: z.object({
            edges: z.array(z.object({ node: z.object({ id: z.string() }) })),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          }),
        }),
      })
      .parse(result.body.data).ticket.messageHistory;
    ids.push(...history.edges.map((e) => e.node.id));
    after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (after);
  expect(ids.length).toBeGreaterThan(100);
  expect(new Set(ids).size).toBe(ids.length);
  const reviews = await graph(token, print(ReviewQueueDocument), { first: 1, status: 'pending' });
  expect(reviews.body.errors).toBeUndefined();
  const data = z
    .object({ reviewQueue: z.object({ pageInfo: z.object({ endCursor: z.string() }) }) })
    .parse(reviews.body.data);
  expect(
    (
      await graph(foreignToken, print(ReviewQueueDocument), {
        first: 1,
        status: 'pending',
        after: data.reviewQueue.pageInfo.endCursor,
      })
    ).body.errors?.[0]?.extensions.code,
  ).toBe('INVALID_CURSOR');
  expect(
    (await graph(token, print(ReviewQueueDocument), { first: 101 })).body.errors?.[0]?.extensions
      .code,
  ).toBe('INVALID_INPUT');
  expect((await graph(token, print(BackgroundJobsDocument))).body.errors).toBeUndefined();
});
test('private upload is idempotent and bounded; invalid types and read-only access are rejected', async () => {
  const storage = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? '',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  try {
    try {
      await storage.send(
        new CreateBucketCommand({ Bucket: process.env.S3_BUCKET ?? 'resolvehub-verification' }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)
      )
        throw error;
    }
  } finally {
    storage.destroy();
  }
  const key = randomUUID();
  const upload = async (body: string, bearer = token, type = 'text/plain', idempotency = key) => {
    const response = await fetch(`${apiUrl}/v1/documents/uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': idempotency,
        'X-Document-Type': type,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    return { response, body: (await response.json()) as unknown };
  };
  const result = await upload('Synthetic policy: The refund window is 14 days after payment.');
  expect(result.response.status).toBe(201);
  const staged = schema('UploadedDocument', result.body);
  expect(staged.objectKey).toMatch(`organizations/${organization}/uploads/`);
  expect(
    (await upload('Synthetic policy: The refund window is 14 days after payment.')).body,
  ).toEqual(result.body);
  expect((await upload('Changed payload')).response.status).toBe(409);
  expect((await upload('test', analyst)).response.status).toBe(403);
  expect(
    (await upload('test', token, 'application/x-executable', randomUUID())).response.status,
  ).toBe(400);
  expect((await upload('', token, 'text/plain', randomUUID())).response.status).toBe(400);
  expect(
    (await upload('x'.repeat(10485761), token, 'text/plain', randomUUID())).response.status,
  ).toBe(413);
});
