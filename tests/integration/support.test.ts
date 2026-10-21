import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { print } from 'graphql';
import { z } from 'zod';
import { createDatabase } from '@resolvehub/db';
import { createToken, tokenDigest, seal } from '../../services/api/src/auth/crypto.js';
import {
  TicketsDocument,
  TicketDetailsDocument,
  KnowledgeSearchDocument,
  KnowledgeDocumentsDocument,
  DraftResponseDocument,
  DashboardSummaryDocument,
} from '../../packages/generated/src/graphql/graphql.js';
import { createApiClient } from '../../packages/generated/src/index.js';
import { rest, graph, schema, apiUrl, assertRest } from '../helpers/contracts.js';

const organizationA = randomUUID();
const organizationB = randomUUID();
const tokenA = createToken();
const tokenB = createToken();
const analyst = createToken();
const agent = createToken();
const membershipA = randomUUID();
const integrationId = randomUUID();
const webhookSecret = randomBytes(32).toString('base64url');
const ticketA = randomUUID();
const ticketB = randomUUID();
const documentA = randomUUID();
const versionA = randomUUID();
const chunkA = randomUUID();
const documentB = randomUUID();
const versionB = randomUUID();
const chunkB = randomUUID();
const oldVersion = randomUUID();
const oldChunk = randomUUID();
const draftA = randomUUID();
const draftB = randomUUID();
const rejectDraft = randomUUID();
const evidenceDraft = randomUUID();
const staleDraft = randomUUID();
const foreignEvidenceDraft = randomUUID();
const jobFailed = randomUUID();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const { pool } = createDatabase(databaseUrl);
const ticketInput = {
  subject: 'Synthetic API ticket',
  customerEmail: 'customer@example.test',
  message: 'Please check my account.',
};

async function credential(org: string, token: string, role: string, id = randomUUID()) {
  await pool.query(
    'INSERT INTO memberships (id,organization_id,subject,role) VALUES ($1,$2,$3,$4)',
    [id, org, `${id}@example.test`, role],
  );
  await pool.query(
    "INSERT INTO api_credentials (token_hash,organization_id,membership_id,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",
    [tokenDigest(token), org, id],
  );
  return id;
}
async function published(
  org: string,
  documentId: string,
  versionId: string,
  chunkId: string,
  text: string,
) {
  await pool.query(
    `INSERT INTO knowledge_documents (id,organization_id,title,status) VALUES ($1,$2,$3,'indexed')`,
    [documentId, org, `Policy ${org === organizationA ? 'A' : 'B'}`],
  );
  await version(org, documentId, versionId);
  await pool.query(
    'INSERT INTO knowledge_chunks (id,organization_id,document_id,version_id,text) VALUES ($1,$2,$3,$4,$5)',
    [chunkId, org, documentId, versionId, text],
  );
  await pool.query(
    "UPDATE document_versions SET status='indexed' WHERE organization_id=$1 AND document_id=$2 AND id=$3",
    [org, documentId, versionId],
  );
  await pool.query(
    'UPDATE knowledge_documents SET active_version_id=$3 WHERE organization_id=$1 AND id=$2',
    [org, documentId, versionId],
  );
}
async function version(org: string, documentId: string, id: string) {
  await pool.query(
    `INSERT INTO document_versions (id,organization_id,document_id,object_key,media_type,size_bytes,sha256)
    VALUES ($1,$2,$3,$4,'text/plain',10,$5)`,
    [id, org, documentId, `organizations/${org}/uploads/${randomUUID()}`, 'a'.repeat(64)],
  );
}
async function draft(
  id: string,
  org: string,
  ticket: string,
  citations: unknown[],
  validated: boolean,
  text = 'Synthetic draft',
) {
  await pool.query(
    `INSERT INTO draft_responses (id,organization_id,ticket_id,text,citations,evidence_validated,model,prompt_version)
    VALUES ($1,$2,$3,$4,$5,$6,'test-fixture','test-v1')`,
    [id, org, ticket, text, JSON.stringify(citations), validated],
  );
}

beforeAll(async () => {
  await pool.query(
    "INSERT INTO organizations (id,name) VALUES ($1,'Contract test A'),($2,'Contract test B')",
    [organizationA, organizationB],
  );
  await credential(organizationA, tokenA, 'admin', membershipA);
  await credential(organizationB, tokenB, 'admin');
  await credential(organizationA, analyst, 'analyst');
  await credential(organizationA, agent, 'agent');
  const master = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(process.env.API_SECRET_KEY);
  await pool.query(
    'INSERT INTO webhook_integrations (id,organization_id,encrypted_secret) VALUES ($1,$2,$3)',
    [
      integrationId,
      organizationA,
      seal(webhookSecret, master, `resolvehub:webhook:${integrationId}`),
    ],
  );
  for (const [id, org, subject] of [
    [ticketA, organizationA, 'Ticket fixture A'],
    [ticketB, organizationB, 'TENANT_B_SECRET_TICKET'],
  ]) {
    await pool.query(
      "INSERT INTO tickets (id,organization_id,subject,customer_email) VALUES ($1,$2,$3,'fixture@example.test')",
      [id, org, subject],
    );
  }
  for (let i = 0; i < 3; i++)
    await pool.query(
      `INSERT INTO tickets (id,organization_id,subject,customer_email,created_at)
    VALUES ($1,$2,$3,'paging@example.test','2026-01-01T00:00:00.000Z')`,
      [randomUUID(), organizationA, `Paging ${i}`],
    );
  await published(
    organizationA,
    documentA,
    versionA,
    chunkA,
    'refundscope: Approved organization A policy.',
  );
  await published(
    organizationB,
    documentB,
    versionB,
    chunkB,
    'refundscope: TENANT_B_SECRET_KNOWLEDGE',
  );
  await version(organizationA, documentA, oldVersion);
  await pool.query(
    'INSERT INTO knowledge_chunks (id,organization_id,document_id,version_id,text) VALUES ($1,$2,$3,$4,$5)',
    [oldChunk, organizationA, documentA, oldVersion, 'refundscope: SUPERSEDED_SECRET'],
  );
  const citation = { documentId: documentA, versionId: versionA, chunkId: chunkA };
  await draft(draftA, organizationA, ticketA, [citation], true);
  await draft(rejectDraft, organizationA, ticketA, [citation], true);
  await draft(
    draftB,
    organizationB,
    ticketB,
    [{ documentId: documentB, versionId: versionB, chunkId: chunkB }],
    true,
    'TENANT_B_SECRET_DRAFT',
  );
  await draft(evidenceDraft, organizationA, ticketA, [], false);
  await draft(
    staleDraft,
    organizationA,
    ticketA,
    [{ documentId: documentA, versionId: oldVersion, chunkId: oldChunk }],
    true,
  );
  await draft(
    foreignEvidenceDraft,
    organizationA,
    ticketA,
    [{ documentId: documentB, versionId: versionB, chunkId: chunkB }],
    true,
  );
  await pool.query(
    `INSERT INTO job_runs (id,organization_id,kind,status,resource_id,payload,request_id)
    VALUES ($1,$2,'draft_response','failed',$3,'{}',$4)`,
    [jobFailed, organizationA, ticketA, randomUUID()],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [
      [organizationA, organizationB],
    ]);
  } finally {
    await pool.end();
  }
});

test('identity requires a real active credential and ignores a forged tenant header', async () => {
  expect((await rest('GET', '/v1/me', '/v1/me')).response.status).toBe(401);
  expect((await rest('GET', '/v1/me', '/v1/me', { token: createToken() })).response.status).toBe(
    401,
  );
  const identity = await rest('GET', '/v1/me', '/v1/me', {
    token: tokenA,
    headers: { 'X-Organization-ID': organizationB },
  });
  expect(schema('Identity', identity.body).organizationId).toBe(organizationA);
  expect(
    (await graph(undefined, print(DashboardSummaryDocument))).body.errors?.[0]?.extensions.code,
  ).toBe('UNAUTHENTICATED');
});

test('revocation, expiration and inactive membership revoke access on the next request', async () => {
  const temporary = createToken();
  const membership = await credential(organizationA, temporary, 'agent');
  await pool.query('UPDATE api_credentials SET revoked_at=now() WHERE token_hash=$1', [
    tokenDigest(temporary),
  ]);
  expect((await rest('GET', '/v1/me', '/v1/me', { token: temporary })).response.status).toBe(401);
  await pool.query(
    "UPDATE api_credentials SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [tokenDigest(temporary)],
  );
  expect((await rest('GET', '/v1/me', '/v1/me', { token: temporary })).response.status).toBe(401);
  await pool.query(
    "UPDATE api_credentials SET expires_at=now()+interval '1 hour' WHERE token_hash=$1",
    [tokenDigest(temporary)],
  );
  await pool.query('UPDATE memberships SET active=false WHERE id=$1', [membership]);
  expect((await rest('GET', '/v1/me', '/v1/me', { token: temporary })).response.status).toBe(401);
});

test('ticket creation persists a message, replays atomically and rejects conflicting or tenant-bearing input', async () => {
  const key = randomUUID();
  const correlation = randomUUID();
  const created = await rest('POST', '/v1/tickets', '/v1/tickets', {
    token: tokenA,
    key,
    body: ticketInput,
    headers: { 'X-Request-ID': correlation },
  });
  expect(created.response.status).toBe(201);
  expect(created.response.headers.get('x-request-id')).toBe(correlation);
  const ticket = schema('Ticket', created.body);
  const replay = await rest('POST', '/v1/tickets', '/v1/tickets', {
    token: tokenA,
    key,
    body: {
      message: ticketInput.message,
      customerEmail: ticketInput.customerEmail,
      subject: ticketInput.subject,
    },
  });
  expect(replay.body).toEqual(created.body);
  expect(
    (
      await rest('POST', '/v1/tickets', '/v1/tickets', {
        token: tokenA,
        key,
        body: { ...ticketInput, subject: 'Changed' },
      })
    ).response.status,
  ).toBe(409);
  expect(
    (
      await rest('POST', '/v1/tickets', '/v1/tickets', {
        token: tokenA,
        key: randomUUID(),
        body: { ...ticketInput, organizationId: organizationB },
      })
    ).response.status,
  ).toBe(400);
  expect(
    (await rest('POST', '/v1/tickets', '/v1/tickets', { token: tokenA, body: ticketInput }))
      .response.status,
  ).toBe(400);
  const other = await rest('POST', '/v1/tickets', '/v1/tickets', {
    token: tokenB,
    key,
    body: ticketInput,
  });
  expect(schema('Ticket', other.body).id).not.toBe(ticket.id);
  const details = await graph(tokenA, print(TicketDetailsDocument), { id: ticket.id });
  expect(details.body.errors).toBeUndefined();
  expect(
    z
      .object({ ticket: z.object({ messages: z.array(z.object({ body: z.string() })) }) })
      .parse(details.body.data).ticket.messages[0]?.body,
  ).toBe(ticketInput.message);
});

test('generated openapi-fetch client sends typed mutations and authenticated reads', async () => {
  const client = createApiClient(apiUrl, tokenA);
  const created = await client.POST('/v1/tickets', {
    params: { header: { 'Idempotency-Key': randomUUID() } },
    body: ticketInput,
  });
  expect(created.response.status).toBe(201);
  assertRest('/v1/tickets', 'POST', created.response, created.data);
  expect(created.data?.subject).toBe(ticketInput.subject);
  const identity = await client.GET('/v1/me');
  expect(identity.data?.organizationId).toBe(organizationA);
});

test('concurrent mutation retries commit only one ticket, receipt and audit event', async () => {
  const key = randomUUID();
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      rest('POST', '/v1/tickets', '/v1/tickets', { token: tokenA, key, body: ticketInput }),
    ),
  );
  const ids = attempts.map((attempt) => schema('Ticket', attempt.body).id);
  expect(new Set(ids).size).toBe(1);
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) FROM audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='ticket.created'",
    [organizationA, ids[0]],
  );
  expect(result.rows[0]?.count).toBe('1');
});

test('analysts can read but cannot mutate or replay an existing mutation receipt', async () => {
  expect((await graph(analyst, print(DashboardSummaryDocument))).body.errors).toBeUndefined();
  const key = randomUUID();
  await rest('POST', '/v1/tickets', '/v1/tickets', { token: tokenA, key, body: ticketInput });
  expect(
    (await rest('POST', '/v1/tickets', '/v1/tickets', { token: analyst, key, body: ticketInput }))
      .response.status,
  ).toBe(403);
});

const connectionSchema = z.object({
  tickets: z.object({
    edges: z.array(z.object({ cursor: z.string(), node: z.object({ id: z.uuid() }) })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
test('pagination has a stable UUID tie-breaker, no duplicates, and query/tenant-bound opaque cursors', async () => {
  const first = await graph(tokenA, print(TicketsDocument), {
    first: 2,
    filter: { query: 'Paging' },
  });
  const page = connectionSchema.parse(first.body.data).tickets;
  expect(page.edges).toHaveLength(2);
  expect(page.pageInfo.hasNextPage).toBe(true);
  const second = await graph(tokenA, print(TicketsDocument), {
    first: 2,
    after: page.pageInfo.endCursor,
    filter: { query: 'Paging' },
  });
  const next = connectionSchema.parse(second.body.data).tickets;
  expect(next.edges).toHaveLength(1);
  expect(next.pageInfo.hasNextPage).toBe(false);
  const ids = [...page.edges, ...next.edges].map((edge) => edge.node.id);
  expect(ids).toEqual([...ids].sort().reverse());
  expect(new Set(ids).size).toBe(3);
  for (const [token, filter, after] of [
    [tokenB, { query: 'Paging' }, page.pageInfo.endCursor],
    [tokenA, { query: 'Changed' }, page.pageInfo.endCursor],
    [tokenA, { query: 'Paging' }, `x${page.pageInfo.endCursor}`],
  ] as const) {
    const result = await graph(token, print(TicketsDocument), { first: 2, after, filter });
    expect(result.body.errors?.[0]?.extensions.code).toBe('INVALID_CURSOR');
  }
});

test('GraphQL page bounds and cost limits reject unbounded work with correlated errors', async () => {
  for (const first of [0, 101]) {
    const result = await graph(tokenA, print(TicketsDocument), { first });
    expect(result.body.errors?.[0]?.extensions.code).toBe('INVALID_INPUT');
  }
  const costly = await graph(
    tokenA,
    '{ tickets(first:100) { edges { node { messages { body } } } } }',
  );
  expect(costly.body.errors?.[0]?.extensions.code).toBe('INVALID_INPUT');
  const unknown = await graph(
    tokenA,
    '{ tickets(organizationId:"forged") { pageInfo { hasNextPage } } }',
  );
  expect(unknown.body.errors?.[0]?.extensions.code).toBe('INVALID_INPUT');
});

test('ticket and draft access do not disclose another tenant’s resources', async () => {
  for (const [query, id] of [
    [print(TicketDetailsDocument), ticketB],
    [print(DraftResponseDocument), draftB],
  ] as const) {
    const result = await graph(tokenA, query, { id });
    expect(result.body.errors?.[0]?.extensions.code).toBe('NOT_FOUND');
    expect(result.body.errors?.[0]?.extensions.httpStatus).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('TENANT_B_SECRET');
  }
});

test('knowledge search returns only the tenant’s active published version', async () => {
  const result = await graph(tokenA, print(KnowledgeSearchDocument), {
    query: 'refundscope',
    first: 10,
  });
  expect(result.body.errors).toBeUndefined();
  const data = z
    .object({
      knowledgeSearch: z.object({
        edges: z.array(z.object({ node: z.object({ chunkId: z.uuid(), versionId: z.uuid() }) })),
      }),
    })
    .parse(result.body.data);
  expect(data.knowledgeSearch.edges.map((edge) => edge.node.chunkId)).toEqual([chunkA]);
  expect(data.knowledgeSearch.edges[0]?.node.versionId).toBe(versionA);
  expect(JSON.stringify(result.body)).not.toContain('TENANT_B_SECRET');
  expect(JSON.stringify(result.body)).not.toContain('SUPERSEDED_SECRET');
  const documents = await graph(tokenA, print(KnowledgeDocumentsDocument));
  expect(documents.body.errors).toBeUndefined();
  const ids = z
    .object({
      knowledgeDocuments: z.object({
        edges: z.array(z.object({ node: z.object({ id: z.uuid() }) })),
      }),
    })
    .parse(documents.body.data)
    .knowledgeDocuments.edges.map((edge) => edge.node.id);
  expect(ids).toContain(documentA);
  expect(ids).not.toContain(documentB);
});

test('ingestion and drafting return durable 202 receipts and actual tenant-safe job states', async () => {
  const input = {
    title: 'Synthetic upload',
    objectKey: `organizations/${organizationA}/uploads/${randomUUID()}`,
    mediaType: 'text/plain',
    sizeBytes: 10,
    sha256: 'b'.repeat(64),
  };
  const result = await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
    token: tokenA,
    key: randomUUID(),
    body: input,
  });
  expect(result.response.status).toBe(202);
  const receipt = schema('AcceptedJob', result.body);
  expect(result.response.headers.get('location')).toBe(receipt.statusUrl);
  const job = await rest('GET', '/v1/jobs/{id}', receipt.statusUrl, { token: tokenA });
  expect(schema('Job', job.body)).toMatchObject({
    kind: 'document_ingestion',
    requestId: receipt.requestId,
  });
  expect(
    (await rest('GET', '/v1/jobs/{id}', receipt.statusUrl, { token: tokenB })).response.status,
  ).toBe(404);
  expect(
    (
      await rest('POST', '/v1/documents/ingestions', '/v1/documents/ingestions', {
        token: tokenA,
        key: randomUUID(),
        body: { ...input, objectKey: `organizations/${organizationB}/uploads/${randomUUID()}` },
      })
    ).response.status,
  ).toBe(403);
  const drafted = await rest('POST', '/v1/tickets/{id}/drafts', `/v1/tickets/${ticketA}/drafts`, {
    token: tokenA,
    key: randomUUID(),
  });
  expect(drafted.response.status).toBe(202);
  expect(
    schema(
      'Job',
      (
        await rest('GET', '/v1/jobs/{id}', schema('AcceptedJob', drafted.body).statusUrl, {
          token: tokenA,
        })
      ).body,
    ).kind,
  ).toBe('draft_response');
});

function webhookHeaders(raw: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'X-Webhook-ID': integrationId,
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': `v1=${createHmac('sha256', webhookSecret).update(timestamp).update('.').update(raw).digest('hex')}`,
  };
}
test('signed webhooks verify raw bytes and time, deduplicate events and reject changed replay', async () => {
  const input = { eventId: randomUUID(), ticket: ticketInput };
  const raw = JSON.stringify(input, null, 2);
  const first = await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
    raw,
    headers: webhookHeaders(raw),
  });
  expect(first.response.status).toBe(202);
  const duplicate = await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
    raw,
    headers: webhookHeaders(raw),
  });
  expect(duplicate.body).toEqual(first.body);
  const uppercase = JSON.stringify({ ...input, eventId: input.eventId.toUpperCase() });
  expect(
    (
      await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
        raw: uppercase,
        headers: webhookHeaders(uppercase),
      })
    ).body,
  ).toEqual(first.body);
  const altered = JSON.stringify({ ...input, ticket: { ...ticketInput, subject: 'Altered' } });
  expect(
    (
      await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
        raw: altered,
        headers: webhookHeaders(altered),
      })
    ).response.status,
  ).toBe(409);
  expect(
    (
      await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
        raw: `${raw} `,
        headers: webhookHeaders(raw),
      })
    ).response.status,
  ).toBe(401);
  for (const delta of [-600, 600])
    expect(
      (
        await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
          raw,
          headers: webhookHeaders(raw, String(Math.floor(Date.now() / 1000) + delta)),
        })
      ).response.status,
    ).toBe(401);
  const oversized = JSON.stringify({
    ...input,
    ticket: { ...ticketInput, message: 'x'.repeat(70000) },
  });
  expect(
    (
      await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
        raw: oversized,
        headers: webhookHeaders(oversized),
      })
    ).response.status,
  ).toBe(413);
  expect(
    (
      await rest('POST', '/v1/webhooks/tickets', '/v1/webhooks/tickets', {
        raw,
        headers: { ...webhookHeaders(raw), 'X-Webhook-ID': randomUUID() },
      })
    ).response.status,
  ).toBe(401);
});

test('approval records one internal reply, is audited and uses revision control', async () => {
  const key = randomUUID();
  const url = `/v1/drafts/${draftA}/approve`;
  const result = await rest('POST', '/v1/drafts/{id}/approve', url, {
    token: tokenA,
    key,
    body: { expectedRevision: 1 },
  });
  expect(result.response.status).toBe(200);
  expect(schema('Draft', result.body)).toMatchObject({
    status: 'approved',
    revision: 2,
    reviewedBy: membershipA,
  });
  expect(
    (
      await rest('POST', '/v1/drafts/{id}/approve', url, {
        token: tokenA,
        key,
        body: { expectedRevision: 1 },
      })
    ).body,
  ).toEqual(result.body);
  expect(
    (
      await rest('POST', '/v1/drafts/{id}/approve', url, {
        token: tokenA,
        key: randomUUID(),
        body: { expectedRevision: 1 },
      })
    ).response.status,
  ).toBe(409);
  expect(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='draft.approved'",
        [organizationA, draftA],
      )
    ).rows[0]?.count,
  ).toBe('1');
  expect(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM ticket_messages WHERE organization_id=$1 AND ticket_id=$2 AND author='agent'",
        [organizationA, ticketA],
      )
    ).rows[0]?.count,
  ).toBe('1');
});

test('review rejects unsafe evidence, stale revisions and inaccessible drafts', async () => {
  for (const id of [evidenceDraft, staleDraft, foreignEvidenceDraft])
    expect(
      (
        await rest('POST', '/v1/drafts/{id}/approve', `/v1/drafts/${id}/approve`, {
          token: tokenA,
          key: randomUUID(),
          body: { expectedRevision: 1 },
        })
      ).response.status,
    ).toBe(422);
  expect(
    (
      await rest('POST', '/v1/drafts/{id}/approve', `/v1/drafts/${draftB}/approve`, {
        token: tokenA,
        key: randomUUID(),
        body: { expectedRevision: 1 },
      })
    ).response.status,
  ).toBe(404);
  expect(
    (
      await rest('POST', '/v1/drafts/{id}/reject', `/v1/drafts/${rejectDraft}/reject`, {
        token: tokenA,
        key: randomUUID(),
        body: { expectedRevision: 99, reason: 'Stale' },
      })
    ).response.status,
  ).toBe(409);
  const rejected = await rest(
    'POST',
    '/v1/drafts/{id}/reject',
    `/v1/drafts/${rejectDraft}/reject`,
    {
      token: tokenA,
      key: randomUUID(),
      body: { expectedRevision: 1, reason: 'Needs a clearer answer.' },
    },
  );
  expect(schema('Draft', rejected.body)).toMatchObject({
    status: 'rejected',
    reviewReason: 'Needs a clearer answer.',
    revision: 2,
  });
});

test('job replay requires an admin, preserves the failure and deduplicates retries', async () => {
  const url = `/v1/jobs/${jobFailed}/replay`;
  const key = randomUUID();
  expect(
    (await rest('POST', '/v1/jobs/{id}/replay', url, { token: agent, key: randomUUID() })).response
      .status,
  ).toBe(403);
  const first = await rest('POST', '/v1/jobs/{id}/replay', url, { token: tokenA, key });
  expect(first.response.status).toBe(202);
  expect((await rest('POST', '/v1/jobs/{id}/replay', url, { token: tokenA, key })).body).toEqual(
    first.body,
  );
  expect(
    (await rest('POST', '/v1/jobs/{id}/replay', url, { token: tokenA, key: randomUUID() })).response
      .status,
  ).toBe(409);
  expect(
    schema(
      'Job',
      (await rest('GET', '/v1/jobs/{id}', `/v1/jobs/${jobFailed}`, { token: tokenA })).body,
    ).status,
  ).toBe('failed');
  expect(
    (await rest('POST', '/v1/jobs/{id}/replay', url, { token: tokenB, key: randomUUID() })).response
      .status,
  ).toBe(404);
});

test('failed mutations roll back their receipt and key can be retried safely', async () => {
  const key = randomUUID();
  expect(
    (
      await rest('POST', '/v1/tickets/{id}/drafts', `/v1/tickets/${ticketB}/drafts`, {
        token: tokenA,
        key,
      })
    ).response.status,
  ).toBe(404);
  expect(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*) FROM idempotency_records WHERE organization_id=$1 AND key=$2',
        [organizationA, key],
      )
    ).rows[0]?.count,
  ).toBe('0');
  expect(
    (await rest('POST', '/v1/tickets', '/v1/tickets', { token: tokenA, key, body: ticketInput }))
      .response.status,
  ).toBe(201);
});

test('dashboard summary and draft response operations resolve from stored tenant data', async () => {
  const summary = await graph(tokenA, print(DashboardSummaryDocument));
  expect(summary.body.errors).toBeUndefined();
  const data = z
    .object({
      dashboardSummary: z.object({
        openTickets: z.number(),
        publishedDocuments: z.number(),
        pendingReviews: z.number(),
      }),
    })
    .parse(summary.body.data).dashboardSummary;
  expect(data.publishedDocuments).toBe(1);
  expect(data.openTickets).toBe(
    Number(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM tickets WHERE organization_id=$1 AND status='open'",
          [organizationA],
        )
      ).rows[0]?.count,
    ),
  );
  const result = await graph(tokenA, print(DraftResponseDocument), { id: draftA });
  expect(
    z.object({ draft: z.object({ status: z.string() }) }).parse(result.body.data).draft.status,
  ).toBe('approved');
});
