import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { print } from 'graphql';
import { createDatabase } from '@resolvehub/db';
import { DraftResponseDocument } from '@resolvehub/generated';
import { tokenDigest } from '../../services/api/src/auth/crypto.js';
import { rest, graph, schema } from '../helpers/contracts.js';
import { loadEvaluationCorpus, readEvaluationFixtures } from '../../packages/ai/evals/runner.js';
import { evalId } from '../../packages/ai/evals/fixtures.js';

jest.setTimeout(30000);
if (!process.env.DATABASE_URL) throw new Error('Isolated database is required');
const pool = createDatabase(process.env.DATABASE_URL).pool;
const tokenA = `rh_${'x'.repeat(43)}`,
  tokenB = `rh_${'y'.repeat(43)}`,
  analyst = `rh_${'z'.repeat(43)}`;
const orgA = evalId('org:0'),
  orgB = evalId('org:1');
const fixtures = await readEvaluationFixtures();
const identity = (org: string) => (org === orgA ? tokenA : tokenB);
async function createTicket(org: string, question: string) {
  const result = await rest('POST', '/v1/tickets', '/v1/tickets', {
    token: identity(org),
    key: randomUUID(),
    body: { subject: question, message: question, customerEmail: 'synthetic@example.test' },
  });
  expect(result.response.status).toBe(201);
  return schema('Ticket', result.body).id;
}
async function request(ticket: string, token = tokenA, key = randomUUID()) {
  const result = await rest('POST', '/v1/tickets/{id}/drafts', `/v1/tickets/${ticket}/drafts`, {
    token,
    key,
    body: {},
  });
  expect(result.response.status).toBe(202);
  return schema('AcceptedJob', result.body);
}
async function finish(job: string, token = tokenA) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const current = schema(
      'Job',
      (await rest('GET', '/v1/jobs/{id}', `/v1/jobs/${job}`, { token })).body,
    );
    if (current.status === 'succeeded') {
      const result = await graph(token, print(DraftResponseDocument), { id: current.resourceId });
      expect(result.body.errors).toBeUndefined();
      return schema('Draft', result.body.data?.draft);
    }
    if (current.status === 'failed') throw new Error(`Draft failed: ${current.reasonCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Draft deadline exceeded');
}
beforeAll(async () => {
  await loadEvaluationCorpus(pool, fixtures.corpus);
  for (const [member, org, token, role] of [
    [evalId('member:0'), orgA, tokenA, 'admin'],
    [evalId('member:1'), orgB, tokenB, 'admin'],
    [evalId('analyst'), orgA, analyst, 'analyst'],
  ]) {
    await pool.query(
      'INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,$3,$4)',
      [member, org, `${member}@example.test`, role],
    );
    await pool.query(
      "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [tokenDigest(String(token)), org, member],
    );
  }
});
afterAll(async () => {
  await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[orgA, orgB]]);
  await pool.end();
});

test('REST draft jobs produce structured GraphQL evidence and require scoped audited human approval', async () => {
  const ticket = await createTicket(orgA, 'What is the refund window?'),
    key = randomUUID();
  const accepted = await request(ticket, tokenA, key);
  expect(await request(ticket, tokenA, key)).toEqual(accepted);
  const draft = await finish(accepted.jobId);
  expect(draft).toMatchObject({
    status: 'pending',
    evidenceValidated: true,
    text: 'The refund window is 14 days after payment. [1]',
    generation: {
      outcome: 'answer',
      provider: 'mock',
      estimatedCostUsd: 0,
      tokenCountSource: 'mock_estimate',
      pricing: { source: 'mock' },
    },
  });
  expect(draft.citations).toEqual([
    expect.objectContaining({
      versionId: evalId('version:0:refund:2'),
      chunkId: evalId('chunk:0:refund:2'),
      quote: 'The refund window is 14 days after payment.',
      reference: '[1]',
    }),
  ]);
  expect(draft.generation?.inputTokens).toBeGreaterThan(0);
  expect(
    (await graph(tokenB, print(DraftResponseDocument), { id: draft.id })).body.errors?.[0]
      ?.extensions.code,
  ).toBe('NOT_FOUND');
  for (const [token, status] of [
    [analyst, 403],
    [tokenB, 404],
  ] as const)
    expect(
      (
        await rest('POST', '/v1/drafts/{id}/approve', `/v1/drafts/${draft.id}/approve`, {
          token,
          key: randomUUID(),
          body: { expectedRevision: 1 },
        })
      ).response.status,
    ).toBe(status);
  const approved = await rest('POST', '/v1/drafts/{id}/approve', `/v1/drafts/${draft.id}/approve`, {
    token: tokenA,
    key: randomUUID(),
    body: { expectedRevision: 1 },
  });
  expect(approved.response.status).toBe(200);
  expect(schema('Draft', approved.body).reviewedBy).toBe(evalId('member:0'));
  expect(
    (
      await pool.query(
        "SELECT id FROM ticket_messages WHERE organization_id=$1 AND ticket_id=$2 AND author='agent'",
        [orgA, ticket],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE organization_id=$1 AND resource_id=$2 AND action='draft.generated'",
        [orgA, draft.id],
      )
    ).rowCount,
  ).toBe(1);
});

test('insufficient evidence creates an explicit abstention that cannot be approved', async () => {
  const ticket = await createTicket(orgA, 'Can I pay with lunar credits?');
  const draft = await finish((await request(ticket)).jobId);
  expect(draft).toMatchObject({
    evidenceValidated: false,
    citations: [],
    generation: { outcome: 'insufficient_evidence', abstentionReason: 'insufficient_evidence' },
  });
  expect(
    (
      await rest('POST', '/v1/drafts/{id}/approve', `/v1/drafts/${draft.id}/approve`, {
        token: tokenA,
        key: randomUUID(),
        body: { expectedRevision: 1 },
      })
    ).response.status,
  ).toBe(422);
});

test('ten simultaneous authenticated draft requests finish with tenant-correct pending answers', async () => {
  const cases = [0, 1].flatMap((tenant) =>
    fixtures.cases
      .filter(
        (row) => row.category === 'answerable' && row.organizationId === evalId(`org:${tenant}`),
      )
      .slice(0, 5),
  );
  const tickets = await Promise.all(
    cases.map((item) => createTicket(item.organizationId, item.question)),
  );
  const elapsed = await Promise.all(
    cases.map(async (item, index) => {
      const ticket = tickets[index];
      if (!ticket) throw new Error('Missing benchmark ticket');
      const start = performance.now(),
        token = identity(item.organizationId),
        draft = await finish((await request(ticket, token)).jobId, token);
      expect(draft.status).toBe('pending');
      expect(draft.citations[0]?.chunkId).toBe(item.expectedEvidence[0]?.chunkId);
      return performance.now() - start;
    }),
  );
  const p95Ms = [...elapsed].sort((a, b) => a - b)[9];
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/ai-http-benchmark.json',
    JSON.stringify(
      {
        provider: 'mock',
        requests: 10,
        concurrency: 10,
        workerConcurrency: 2,
        p95Ms,
        elapsedMs: elapsed,
        includes: 'authenticated REST submission, BullMQ queue, worker RAG and GraphQL polling',
        excludes: 'ticket fixture creation',
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  expect(p95Ms).toBeLessThanOrEqual(6000);
});

test('approval rejects a formerly cited version deleted after generation', async () => {
  const ticket = await createTicket(orgA, 'What is the session timeout?'),
    draft = await finish((await request(ticket)).jobId);
  expect(draft.evidenceValidated).toBe(true);
  await pool.query(
    'UPDATE document_versions SET deleted_at=now() WHERE organization_id=$1 AND id=$2',
    [orgA, evalId('version:0:session:2')],
  );
  expect(
    (
      await rest('POST', '/v1/drafts/{id}/approve', `/v1/drafts/${draft.id}/approve`, {
        token: tokenA,
        key: randomUUID(),
        body: { expectedRevision: 1 },
      })
    ).response.status,
  ).toBe(422);
});
