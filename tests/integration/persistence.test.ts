import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  ContractStore,
  createDatabase,
  DraftSession,
  IngestionSession,
  KnowledgeRepository,
  migrate,
  schema,
  tenantTransaction,
} from '@resolvehub/db';
import { buildFixtures, fixtureId, syntheticEmbedding } from '../../packages/db/seeds/fixtures.js';
import { seedSynthetic } from '../../packages/db/seeds/seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const admin = createDatabase(databaseUrl).pool;
const schemaName = `rh_data_${randomUUID().replaceAll('-', '')}`;
const url = new URL(databaseUrl);
url.searchParams.set('options', `-c search_path=${schemaName}`);
const pool = createDatabase(url.toString()).pool;
const orgA = fixtureId('org:0'),
  orgB = fixtureId('org:1');
const actor = {
  organizationId: orgA,
  actorKind: 'membership' as const,
  actorId: fixtureId('member:0'),
  requestId: randomUUID(),
};
const repository = new KnowledgeRepository(pool, orgA);
const store = new ContractStore(pool);
const directory = pathToFileURL(`${process.cwd()}/packages/db/migrations/`);

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schemaName}"`);
  await migrate(pool, directory);
  await seedSynthetic(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await admin.end();
});

async function snapshot() {
  const tables = [
    'organizations',
    'memberships',
    'customers',
    'tickets',
    'ticket_messages',
    'knowledge_documents',
    'document_versions',
    'knowledge_chunks',
    'draft_responses',
    'citations',
    'job_runs',
    'audit_events',
    'idempotency_records',
  ];
  const hash = createHash('sha256');
  for (const table of tables) {
    const data = await pool.query(
      `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
    );
    hash.update(JSON.stringify(data.rows));
  }
  return hash.digest('hex');
}

test('Faker corpus and all persisted rows repeat exactly, replacing only the reserved synthetic organizations', async () => {
  expect(buildFixtures()).toEqual(buildFixtures());
  const outside = randomUUID();
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Unrelated data preserved')", [
    outside,
  ]);
  const first = await snapshot();
  expect(await seedSynthetic(pool)).toEqual({
    organizations: 2,
    documents: 100,
    tickets: 200,
    versions: 300,
    messages: 900,
  });
  expect(await snapshot()).toBe(first);
  const count = await pool.query<{
    docs: number;
    tickets: number;
    versions: number;
    customers: number;
    citations: number;
  }>(
    `SELECT (SELECT count(*)::int FROM knowledge_documents) docs,(SELECT count(*)::int FROM tickets) tickets,(SELECT count(*)::int FROM document_versions) versions,(SELECT count(*)::int FROM customers) customers,(SELECT count(*)::int FROM citations) citations`,
  );
  expect(count.rows[0]).toEqual({
    docs: 100,
    tickets: 200,
    versions: 300,
    customers: 80,
    citations: 60,
  });
  const delivery = await pool.query<{ invalid: number }>(
    `SELECT count(*)::int invalid FROM ticket_messages WHERE
      (author='agent' AND delivery_status<>'internal') OR
      (author='customer' AND delivery_status<>'received')`,
  );
  expect(delivery.rows[0]?.invalid).toBe(0);
  await pool.query('DELETE FROM organizations WHERE id=$1', [outside]);
});

test('Drizzle tables match migrated PostgreSQL columns, nullability and types', async () => {
  for (const table of Object.values(schema)) {
    const config = getTableConfig(table);
    const result = await pool.query<{ column_name: string; is_nullable: string; type: string }>(
      `SELECT a.attname column_name,CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END is_nullable,format_type(a.atttypid,a.atttypmod) type FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`,
      [schemaName, config.name],
    );
    expect(result.rows.map((r) => r.column_name)).toEqual(config.columns.map((c) => c.name).sort());
    const policy = await pool.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [schemaName, config.name],
    );
    expect(policy.rows[0]?.relrowsecurity).toBe(config.enableRLS);
    const policies = await pool.query<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename=$2 ORDER BY policyname`,
      [schemaName, config.name],
    );
    expect(policies.rows.map((p) => p.policyname)).toEqual(
      config.policies.map((p) => p.name).sort(),
    );
    for (const column of config.columns) {
      const actual = result.rows.find((r) => r.column_name === column.name);
      expect(actual?.is_nullable).toBe(column.notNull ? 'NO' : 'YES');
      const normalize = (type: string) => type.replace('public.', '').replaceAll(/\s+/g, '');
      expect(normalize(actual?.type ?? '')).toBe(normalize(column.getSQLType()));
    }
  }
});

test('tenant-bound queries, composite relationships and exact vector retrieval exclude other tenants and obsolete versions', async () => {
  const a = await repository.nearest(syntheticEmbedding('duplicate charge'), 100);
  expect(a).toHaveLength(100);
  const allowed = new Set(
    buildFixtures()
      .chunks.filter((c) => c.organizationId === orgA)
      .map((c) => c.id),
  );
  expect(a.every((row) => allowed.has(row.id))).toBe(true);
  expect(a.some((row) => row.text.includes('OUTDATED'))).toBe(false);
  expect(await store.tenant(orgA).ticket(fixtureId('ticket:1:0'))).toBeUndefined();
  await expect(
    repository.publish(fixtureId('doc:1:0'), fixtureId('version:1:0:2'), actor),
  ).rejects.toThrow('not_found');
  await expect(
    pool.query(
      'INSERT INTO ticket_messages(id,organization_id,ticket_id,body,author) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), orgA, fixtureId('ticket:1:0'), 'Cross-tenant attempt', 'customer'],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    pool.query(
      'UPDATE knowledge_documents SET active_version_id=$1 WHERE organization_id=$2 AND id=$3',
      [fixtureId('version:1:0:2'), orgA, fixtureId('doc:0:0')],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await expect(
    pool.query('UPDATE document_versions SET revision=1 WHERE organization_id=$1 AND id=$2', [
      orgA,
      fixtureId('version:0:0:3'),
    ]),
  ).rejects.toMatchObject({ code: '23505' });
  await expect(
    pool.query(
      'INSERT INTO citations(organization_id,draft_id,document_id,version_id,chunk_id,position) VALUES($1,$2,$3,$4,$5,99)',
      [
        orgA,
        fixtureId('draft:0:0'),
        fixtureId('doc:1:0'),
        fixtureId('version:1:0:2'),
        fixtureId('chunk:1:0:2:0'),
      ],
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

test('non-owner RLS fails closed without context and denies cross-tenant reads/writes without pool leakage', async () => {
  const client = await pool.connect();
  const role = `rh_runtime_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA "${schemaName}" TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO "${role}"`,
    );
    await client.query(`SET LOCAL ROLE "${role}"`);
    expect((await client.query('SELECT id FROM tickets')).rows).toEqual([]);
    await client.query("SELECT set_config('resolvehub.organization_id',$1,true)", [orgA]);
    const rows = await client.query<{ organization_id: string }>(
      'SELECT organization_id FROM tickets',
    );
    expect(rows.rowCount).toBe(100);
    expect(rows.rows.every((row) => row.organization_id === orgA)).toBe(true);
    expect(
      (
        await client.query('UPDATE tickets SET subject=$1 WHERE id=$2', [
          'Forbidden',
          fixtureId('ticket:1:0'),
        ])
      ).rowCount,
    ).toBe(0);
    await client.query('SAVEPOINT rejected_write');
    await expect(
      client.query(
        "INSERT INTO customers(id,organization_id,email) VALUES($1,$2,'deny@example.test')",
        [randomUUID(), orgB],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT rejected_write');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  await tenantTransaction(pool, orgA, async (client) => {
    expect(
      (await client.query("SELECT current_setting('resolvehub.organization_id') AS tenant"))
        .rows[0],
    ).toEqual({ tenant: orgA });
  });
  const context = await pool.query(
    "SELECT nullif(current_setting('resolvehub.organization_id',true),'') AS tenant",
  );
  expect(context.rows[0]).toEqual({ tenant: null });
});

test('replacement publication is atomic, idempotent, audited and keeps the previous active version on invalid replacement', async () => {
  const doc = fixtureId('doc:0:0'),
    old = fixtureId('version:0:0:2'),
    next = fixtureId('version:0:0:3');
  const current = async () =>
    (await pool.query('SELECT active_version_id FROM knowledge_documents WHERE id=$1', [doc]))
      .rows[0]?.active_version_id;
  await expect(repository.publish(doc, next, actor)).rejects.toThrow('state');
  expect(await current()).toBe(old);
  await pool.query("UPDATE document_versions SET status='processing' WHERE id=$1", [next]);
  await pool.query(
    'UPDATE knowledge_chunks SET embedding=NULL,embedding_model=NULL,embedding_dimensions=NULL WHERE version_id=$1',
    [next],
  );
  await expect(repository.publish(doc, next, actor)).rejects.toThrow('evidence');
  expect(await current()).toBe(old);
  const fixtures = buildFixtures();
  for (const chunk of fixtures.chunks.filter((c) => c.versionId === next))
    await pool.query(
      'UPDATE knowledge_chunks SET embedding=$1::public.vector,embedding_model=$2,embedding_dimensions=$3 WHERE id=$4',
      [JSON.stringify(chunk.embedding), chunk.embeddingModel, chunk.embeddingDimensions, chunk.id],
    );
  // A deferred audit constraint failure simulates failure after all writes.
  const badActor = { ...actor, requestId: 'invalid' };
  await expect(repository.publish(doc, next, badActor)).rejects.toThrow();
  expect(await current()).toBe(old);
  await Promise.all([repository.publish(doc, next, actor), repository.publish(doc, next, actor)]);
  expect(await current()).toBe(next);
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE action='document.published' AND resource_id=$1",
        [next],
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (await pool.query('SELECT status FROM document_versions WHERE id=$1', [old])).rows[0],
  ).toEqual({ status: 'superseded' });
});

test('soft deleted documents, versions and chunks disappear from vector, lexical search and evidence approval queries', async () => {
  const doc = fixtureId('doc:0:1'),
    version = fixtureId('version:0:1:3'),
    chunk = fixtureId('chunk:0:1:3:0');
  const hasDoc = async () =>
    (await repository.nearest(syntheticEmbedding('reset password'), 100)).some(
      (row) => row.documentId === doc,
    );
  expect(await hasDoc()).toBe(true);
  await pool.query('UPDATE knowledge_chunks SET deleted_at=now() WHERE id=$1', [chunk]);
  expect(
    (await repository.nearest(syntheticEmbedding('reset password'), 100)).some(
      (row) => row.id === chunk,
    ),
  ).toBe(false);
  await pool.query('UPDATE knowledge_documents SET deleted_at=now() WHERE id=$1', [doc]);
  expect(await hasDoc()).toBe(false);
  await pool.query('UPDATE knowledge_documents SET deleted_at=NULL WHERE id=$1', [doc]);
  // Even a privileged direct deletion leaving an active pointer fails closed.
  await pool.query('UPDATE document_versions SET deleted_at=now() WHERE id=$1', [version]);
  expect(await hasDoc()).toBe(false);
  const page = { first: 100, snapshot: new Date('2030-01-01').toISOString() };
  const lexical = await store.tenant(orgA).search('reset', page);
  expect(
    lexical.some(
      (row) =>
        typeof row === 'object' && row !== null && 'documentId' in row && row.documentId === doc,
    ),
  ).toBe(false);
  expect(
    await store
      .tenant(orgA)
      .activeCitation({ documentId: doc, versionId: version, chunkId: chunk }),
  ).toBe(false);
  await pool.query('UPDATE document_versions SET deleted_at=NULL WHERE id=$1', [version]);
  await repository.deleteVersion(doc, version, actor);
  expect(await hasDoc()).toBe(false);
  await expect(repository.publish(doc, version, actor)).rejects.toThrow('not_found');
});

test('database and application reject incompatible embedding dimensions and models', async () => {
  const id = fixtureId('chunk:0:2:3:0');
  await expect(repository.nearest([1, 0])).rejects.toThrow('Invalid embedding vector');
  await expect(repository.nearest(Array(64).fill(0))).rejects.toThrow('Invalid embedding vector');
  await expect(
    pool.query("UPDATE knowledge_chunks SET embedding='[1,0]'::public.vector WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: '22000' });
  await expect(
    pool.query("UPDATE knowledge_chunks SET embedding_model='unknown' WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: '23503' });
});

test('tenant retrieval index exists and can bound the candidate scan', async () => {
  const indexes = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='chunks_retrieval'`,
    [schemaName],
  );
  expect(indexes.rows[0]?.indexdef).toContain('(organization_id, document_id, version_id, id)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan=off');
    const plan = await client.query(
      'EXPLAIN SELECT id FROM knowledge_chunks WHERE organization_id=$1 AND deleted_at IS NULL AND embedding IS NOT NULL',
      [orgA],
    );
    expect(JSON.stringify(plan.rows)).toContain('chunks_retrieval');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('initial-only rollback works and refuses an expanded database without touching data', async () => {
  const sql = await readFile('packages/db/rollback/0001_initial.sql', 'utf8');
  const client = await pool.connect();
  try {
    await expect(client.query(sql)).rejects.toThrow('Initial rollback refused');
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  expect((await pool.query('SELECT id FROM organizations')).rowCount).toBe(2);
});

test('the provisioned runtime grants support authentication, scoped mutations and retrieval while protecting audit history', async () => {
  const role = `rh_app_${randomUUID().replaceAll('-', '')}`;
  const grants = (await readFile('infra/docker/runtime-grants.sql', 'utf8')).replaceAll(
    'resolvehub_runtime',
    role,
  );
  const runtimeUrl = new URL(url.toString());
  runtimeUrl.searchParams.set('options', `-c search_path=${schemaName} -c role=${role}`);
  const runtime = createDatabase(runtimeUrl.toString()).pool;
  const adminClient = await pool.connect();
  try {
    await adminClient.query('BEGIN');
    await adminClient.query(grants);
    await adminClient.query('COMMIT');
    const digest = createHash('sha256').update('synthetic-runtime-test').digest('hex');
    await pool.query(
      "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [digest, orgA, actor.actorId],
    );
    const runtimeStore = new ContractStore(runtime);
    expect(await runtimeStore.authenticate(digest)).toMatchObject({
      organizationId: orgA,
      membershipId: actor.actorId,
    });
    expect(await runtimeStore.authenticate('0'.repeat(64))).toBeUndefined();
    const integrationId = randomUUID();
    await pool.query(
      "INSERT INTO webhook_integrations(id,organization_id,encrypted_secret) VALUES($1,$2,'synthetic-envelope')",
      [integrationId, orgA],
    );
    expect(await runtimeStore.integration(integrationId)).toMatchObject({ organizationId: orgA });
    expect(await runtimeStore.tenant(orgA).ticket(fixtureId('ticket:1:0'))).toBeUndefined();
    const receipt = await runtimeStore.mutate(
      actor,
      'runtime-create',
      'ticket.create',
      'runtime-fingerprint',
      async (repo) => {
        const ticket = await repo.createTicket({
          subject: 'Synthetic runtime ticket',
          customerEmail: 'runtime@example.test',
          message: 'Can I export my report?',
        });
        await repo.audit(actor, 'ticket.created', fixtureId('runtime-audit'));
        expect(ticket).toMatchObject({ subject: 'Synthetic runtime ticket' });
        return { status: 201, body: { created: true } };
      },
    );
    expect(receipt.status).toBe(201);
    expect(
      await new KnowledgeRepository(runtime, orgA).nearest(syntheticEmbedding('report')),
    ).toHaveLength(5);
    expect((await runtime.query('SELECT id FROM tickets')).rowCount).toBe(0);
    await expect(
      runtime.query('SELECT * FROM ingestion_dispatch_candidates()'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query("UPDATE audit_events SET action='tampered'")).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await adminClient.query('ROLLBACK');
    adminClient.release();
    await runtime.end();
    await pool.query(`DROP OWNED BY "${role}"`);
    await pool.query(`DROP ROLE "${role}"`);
  }
});

test('ticket soft deletion hides its messages and drafts, and mutable timestamps are maintained by PostgreSQL', async () => {
  const ticketId = fixtureId('ticket:0:2');
  expect(await store.tenant(orgA).draft(fixtureId('draft:0:2'))).toBeDefined();
  await pool.query('UPDATE tickets SET deleted_at=now() WHERE organization_id=$1 AND id=$2', [
    orgA,
    ticketId,
  ]);
  expect(await store.tenant(orgA).ticket(ticketId)).toBeUndefined();
  expect(await store.tenant(orgA).messages(ticketId)).toEqual([]);
  expect(await store.tenant(orgA).drafts(ticketId)).toEqual([]);
  expect(await store.tenant(orgA).draft(fixtureId('draft:0:2'))).toBeUndefined();
  const lifecycle = await pool.query(
    'SELECT updated_at>created_at AS touched,deleted_at IS NOT NULL AS deleted FROM tickets WHERE id=$1',
    [ticketId],
  );
  expect(lifecycle.rows[0]).toEqual({ touched: true, deleted: true });
});

test('knowledge deletion and publication refuse forged actors, foreign documents and missing versions', async () => {
  const doc = fixtureId('doc:0:3'),
    version = fixtureId('version:0:3:3');
  for (const operation of [
    () => repository.publish(doc, version, { ...actor, organizationId: orgB }),
    () => repository.deleteVersion(doc, version, { ...actor, organizationId: orgB }),
    () => repository.deleteVersion(fixtureId('doc:1:3'), version, actor),
    () => repository.deleteVersion(doc, randomUUID(), actor),
  ])
    await expect(operation()).rejects.toThrow('not_found');
  const before = (
    await pool.query('SELECT active_version_id FROM knowledge_documents WHERE id=$1', [doc])
  ).rows[0];
  const old = fixtureId('version:0:3:1');
  await pool.query("UPDATE document_versions SET status='processing' WHERE id=$1", [old]);
  await expect(repository.publish(doc, old, actor)).rejects.toThrow('state');
  expect(
    (await pool.query('SELECT active_version_id FROM knowledge_documents WHERE id=$1', [doc]))
      .rows[0],
  ).toEqual(before);
  await repository.deleteVersion(doc, version, actor);
  await repository.deleteVersion(doc, version, actor);
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE resource_id=$1 AND action='document.version_deleted'",
        [version],
      )
    ).rowCount,
  ).toBe(1);
  expect(await repository.nearest(syntheticEmbedding('policy'), 100)).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ versionId: version })]),
  );
});

test('punctuation-only hybrid queries retain tenant filtering without lexical terms', async () => {
  const rows = await repository.search('?!', syntheticEmbedding('?!'), 5);
  expect(rows).toHaveLength(5);
  expect(rows.every((row) => row.organizationId === orgA && row.lexicalRank === 0)).toBe(true);
});

test('stable continuation pages for documents, search, reviews, jobs and messages never repeat rows or cross tenants', async () => {
  const repo = store.tenant(orgA),
    snapshot = new Date('2030-01-01').toISOString();
  const readRow = (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('createdAt' in value) ||
      typeof value.createdAt !== 'string'
    )
      throw new Error('Missing timestamp');
    const id = 'id' in value ? value.id : 'chunkId' in value ? value.chunkId : undefined;
    if (typeof id !== 'string') throw new Error('Missing row identifier');
    return { id, createdAt: value.createdAt };
  };
  const readers = [
    (page: { first: number; snapshot: string; last?: { id: string; createdAt: string } }) =>
      repo.documents(page),
    (page: { first: number; snapshot: string; last?: { id: string; createdAt: string } }) =>
      repo.search('the', page),
    (page: { first: number; snapshot: string; last?: { id: string; createdAt: string } }) =>
      repo.reviewQueue(page, 'pending'),
    (page: { first: number; snapshot: string; last?: { id: string; createdAt: string } }) =>
      repo.backgroundJobs(page),
    (page: { first: number; snapshot: string; last?: { id: string; createdAt: string } }) =>
      repo.messageHistory(fixtureId('ticket:0:0'), page),
  ];
  // Supply enough deterministic rows even where the seed intentionally has no jobs.
  for (let i = 0; i < 3; i++)
    await repo.createJob(
      'draft_response',
      fixtureId('ticket:0:0'),
      { ticketId: fixtureId('ticket:0:0') },
      actor.requestId,
      null,
      actor.actorId,
    );
  for (const read of readers) {
    const first = await read({ first: 1, snapshot });
    expect(first.length).toBeGreaterThanOrEqual(2);
    const last = readRow(first[0]);
    const second = await read({ first: 1, snapshot, last });
    expect(second.length).toBeGreaterThanOrEqual(1);
    expect(second.map(readRow).map((row) => row.id)).not.toContain(last.id);
  }
  expect(
    await store.tenant(orgB).messageHistory(fixtureId('ticket:0:0'), { first: 2, snapshot }),
  ).toEqual([]);
});

test('unapproved replies and mismatched audit actors fail without persisting a message or idempotency receipt', async () => {
  const key = randomUUID(),
    draft = fixtureId('draft:0:5');
  const messages = () =>
    pool.query('SELECT id FROM ticket_messages WHERE source_draft_id=$1', [draft]);
  const before = (await messages()).rowCount;
  await expect(
    store.mutate(actor, key, 'approval-guard', '', async (repo) => {
      await repo.recordApprovedReply(draft);
      return { status: 200, body: null };
    }),
  ).rejects.toThrow('state');
  expect((await messages()).rowCount).toBe(before);
  expect(
    (
      await pool.query('SELECT key FROM idempotency_records WHERE organization_id=$1 AND key=$2', [
        orgA,
        key,
      ])
    ).rowCount,
  ).toBe(0);
  await expect(
    store.tenant(orgA).audit({ ...actor, organizationId: orgB }, 'forged', draft),
  ).rejects.toThrow('Audit context mismatch');
});

test('dead-letter replay rejects missing, foreign, unfinished, ineligible and stale-version jobs transactionally', async () => {
  const doc = fixtureId('doc:0:4'),
    version = fixtureId('version:0:4:3');
  const repo = store.tenant(orgA);
  await expect(repo.replay(randomUUID(), actor.requestId, actor.actorId)).rejects.toThrow(
    'not_found',
  );
  const pending = await repo.createJob(
    'draft_response',
    fixtureId('ticket:0:0'),
    { ticketId: fixtureId('ticket:0:0') },
    actor.requestId,
    null,
    actor.actorId,
  );
  await expect(store.tenant(orgB).replay(pending, actor.requestId, actor.actorId)).rejects.toThrow(
    'not_found',
  );
  await expect(repo.replay(pending, actor.requestId, actor.actorId)).rejects.toThrow('state');
  const deny = async (kind: string, withFailure: boolean, replayEligible: boolean) => {
    const id = await repo.createJob(
      kind,
      doc,
      kind === 'document_ingestion'
        ? { documentId: doc, versionId: version }
        : { ticketId: fixtureId('ticket:0:0') },
      actor.requestId,
      null,
      actor.actorId,
    );
    await pool.query("UPDATE job_runs SET status='failed' WHERE id=$1", [id]);
    if (withFailure)
      await pool.query(
        "INSERT INTO failed_jobs(id,organization_id,job_id,error_category,summary,input_fingerprint,request_id,replay_eligible) VALUES(gen_random_uuid(),$1,$2,'RESOURCE_UNAVAILABLE','Synthetic guard fixture',$3,$4,$5)",
        [orgA, id, 'a'.repeat(64), actor.requestId, replayEligible],
      );
    const key = randomUUID();
    await expect(
      store.mutate(actor, key, 'replay-guard', '', async (tx) => ({
        status: 202,
        body: { id: await tx.replay(id, actor.requestId, actor.actorId) },
      })),
    ).rejects.toThrow('state');
    expect((await pool.query('SELECT id FROM job_runs WHERE replay_of=$1', [id])).rowCount).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT key FROM idempotency_records WHERE organization_id=$1 AND key=$2',
          [orgA, key],
        )
      ).rowCount,
    ).toBe(0);
  };
  await deny('draft_response', true, false);
  await deny('document_ingestion', false, false);
  await deny('document_ingestion', true, true); // The version is indexed, never replayable as a failed ingestion.
});

test.each(['draft', 'ingestion'] as const)(
  '%s sessions discard terminated connections and open a fresh tenant-clean connection',
  async (kind) => {
    const isolated = createDatabase(url.toString(), { maxConnections: 1 }).pool;
    const repo = store.tenant(orgA);
    const id = await repo.createJob(
      kind === 'draft' ? 'draft_response' : 'document_ingestion',
      fixtureId('ticket:0:0'),
      kind === 'draft'
        ? { ticketId: fixtureId('ticket:0:0') }
        : { documentId: fixtureId('doc:0:0'), versionId: fixtureId('version:0:0:3') },
      actor.requestId,
      null,
      actor.actorId,
    );
    try {
      const previous = (await isolated.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
        .rows[0]?.pid;
      expect(previous).toEqual(expect.any(Number));
      const session =
        kind === 'draft'
          ? await DraftSession.open(isolated, orgA, id)
          : await IngestionSession.open(isolated, orgA, id);
      if (!session) throw new Error('Missing fixture session');
      try {
        expect(
          (await pool.query('SELECT pg_terminate_backend($1) terminated', [previous])).rows[0]
            ?.terminated,
        ).toBe(true);
      } finally {
        await session.close();
      }
      const next = (
        await isolated.query<{ pid: number; tenant: string | null }>(
          "SELECT pg_backend_pid() pid,nullif(current_setting('resolvehub.organization_id',true),'') tenant",
        )
      ).rows[0];
      expect(next?.pid).not.toBe(previous);
      expect(next?.tenant).toBeNull();
    } finally {
      await isolated.end();
    }
  },
);

test.each(['draft', 'ingestion'] as const)(
  '%s session setup errors discard connections instead of leaking locks or tenant context',
  async (kind) => {
    const empty = `rh_empty_${randomUUID().replaceAll('-', '')}`,
      failedUrl = new URL(url.toString());
    await pool.query(`CREATE SCHEMA "${empty}"`);
    failedUrl.searchParams.set('options', `-c search_path=${empty}`);
    const isolated = createDatabase(failedUrl.href, { maxConnections: 1 }).pool;
    try {
      const open =
        kind === 'draft'
          ? DraftSession.open(isolated, orgA, randomUUID())
          : IngestionSession.open(isolated, orgA, randomUUID());
      await expect(open).rejects.toMatchObject({ code: '42P01' });
      expect(
        (
          await isolated.query(
            "SELECT nullif(current_setting('resolvehub.organization_id',true),'') tenant",
          )
        ).rows[0]?.tenant,
      ).toBeNull();
      expect(
        (
          await isolated.query(
            "SELECT count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'",
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      await isolated.end();
      await pool.query(`DROP SCHEMA "${empty}"`);
    }
  },
);
