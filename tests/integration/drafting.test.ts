import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createDatabase,
  migrate,
  ContractStore,
  DraftSession,
  KnowledgeRepository,
} from '@resolvehub/db';
import {
  DraftingPipeline,
  ExtractiveMockProvider,
  SyntheticEmbeddingProvider,
  draftConfigSchema,
  EmbeddingProviderError,
} from '@resolvehub/ai';
import type { RagDraft } from '@resolvehub/ai';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { draftProcessor } from '../../services/worker/src/drafting/processor.js';
import { createDraftRuntime, DRAFT_QUEUE } from '../../services/worker/src/drafting/runtime.js';
import { parseWorkerEnv } from '../../services/worker/src/env.js';
import { ingestionBackoff, ingestionOptions } from '../../services/worker/src/ingestion/runtime.js';
import { loadEvaluationCorpus, readEvaluationFixtures } from '../../packages/ai/evals/runner.js';
import { evalId } from '../../packages/ai/evals/fixtures.js';
import { schema } from '../helpers/contracts.js';

jest.setTimeout(30000);
if (!process.env.DATABASE_URL || !process.env.REDIS_URL)
  throw new Error('Isolated infrastructure required');
const namespace = `rh_draft_${randomUUID().replaceAll('-', '')}`,
  admin = createDatabase(process.env.DATABASE_URL).pool;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('options', `-c search_path=${namespace}`);
const pool = createDatabase(url.toString(), { maxConnections: 8 }).pool,
  store = new ContractStore(pool);
const org = evalId('org:0'),
  member = evalId('draft-member'),
  orgB = evalId('org:1');
const actor = {
  organizationId: org,
  actorId: member,
  actorKind: 'membership' as const,
  requestId: randomUUID(),
};
const config = draftConfigSchema.parse({});
const pipeline = new DraftingPipeline(
  new SyntheticEmbeddingProvider(),
  new ExtractiveMockProvider(),
  {
    search: (org, question, vector, first) =>
      new KnowledgeRepository(pool, org).search(question, vector, first),
  },
  config,
);
async function createJob(question = 'What is the refund window?') {
  let ticket: string | undefined, id: string | undefined;
  await store.mutate(actor, randomUUID(), 'draft-test', question, async (repo) => {
    ticket = schema(
      'Ticket',
      await repo.createTicket({
        subject: question,
        customerEmail: 'synthetic@example.test',
        message: question,
      }),
    ).id;
    id = await repo.createJob(
      'draft_response',
      ticket,
      { ticketId: ticket },
      actor.requestId,
      null,
      member,
    );
    return { status: 202, body: { id } };
  });
  if (!id || !ticket) throw new Error('Missing fixture job');
  return { id, ticket, data: { organizationId: org, jobId: id } };
}
const job = async (id: string) => schema('Job', await store.tenant(org).job(id));
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  for (let n = 0; n < 300; n++) {
    const value = await read();
    if (match(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Draft state deadline exceeded');
}
const processDraft = draftProcessor({ pool, pipeline, retryBaseMs: 10 });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${namespace}"`);
  await migrate(pool, new URL('../../packages/db/migrations/', import.meta.url));
  await loadEvaluationCorpus(pool, (await readEvaluationFixtures()).corpus);
  await pool.query(
    "INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,'synthetic@example.test','admin')",
    [member, org],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${namespace}" CASCADE`);
  await admin.end();
});

test('duplicate delivery locks one job and publishes one pending draft and audit', async () => {
  const input = await createJob();
  await Promise.all([processDraft(input.data), processDraft(input.data)]);
  await processDraft(input.data);
  expect(await job(input.id)).toMatchObject({
    status: 'succeeded',
    attempts: 1,
    resourceId: input.id,
  });
  expect(schema('Draft', await store.tenant(org).draft(input.id))).toMatchObject({
    status: 'pending',
    generation: { accountedAttempts: 1, usageIncomplete: false },
  });
  expect(
    (
      await pool.query(
        "SELECT id FROM audit_events WHERE resource_id=$1 AND action='draft.generated'",
        [input.id],
      )
    ).rowCount,
  ).toBe(1);
  expect(await store.tenant(orgB).draft(input.id)).toBeUndefined();
});
test('envelope, missing/foreign job and not-yet-due claims never authorize work', async () => {
  await expect(processDraft({ organizationId: org, jobId: 'bad' })).rejects.toThrow(
    'Invalid draft envelope',
  );
  await expect(processDraft({ organizationId: org, jobId: randomUUID() })).resolves.toBeUndefined();
  const input = await createJob();
  await expect(processDraft({ organizationId: orgB, jobId: input.id })).resolves.toBeUndefined();
  await pool.query("UPDATE job_runs SET available_at=now()+interval '1 hour' WHERE id=$1", [
    input.id,
  ]);
  await processDraft(input.data);
  expect((await job(input.id)).attempts).toBe(0);
});
test.each(['payload', 'revoked'] as const)(
  '%s authority fails permanently before provider access',
  async (kind) => {
    const input = await createJob();
    if (kind === 'payload')
      await pool.query("UPDATE job_runs SET payload='{}' WHERE id=$1", [input.id]);
    else await pool.query('UPDATE memberships SET active=false WHERE id=$1', [member]);
    const run = jest.fn<typeof pipeline.run>();
    try {
      await expect(draftProcessor({ pool, pipeline: { run } })(input.data)).rejects.toThrow(
        'RESOURCE_UNAVAILABLE',
      );
    } finally {
      await pool.query('UPDATE memberships SET active=true WHERE id=$1', [member]);
    }
    expect(run).not.toHaveBeenCalled();
    expect(schema('FailedJob', await store.tenant(org).failure(input.id))).toMatchObject({
      replayEligible: false,
      attemptHistory: [expect.objectContaining({ attempt: 1 })],
    });
  },
);
test('publication rollback retains provider usage and retry includes cumulative known token cost', async () => {
  const input = await createJob();
  await pool.query(
    `CREATE FUNCTION fail_draft_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='draft.generated' AND NEW.resource_id='${input.id}'::uuid THEN RAISE EXCEPTION 'injected publication rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_draft_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_draft_audit()`,
  );
  await expect(processDraft(input.data)).rejects.toThrow('requires retry');
  expect(await store.tenant(org).draft(input.id)).toBeUndefined();
  expect(
    (await pool.query('SELECT id FROM citations WHERE draft_id=$1', [input.id])).rowCount,
  ).toBe(0);
  expect(
    (await pool.query('SELECT usage FROM job_attempts WHERE job_id=$1', [input.id])).rows[0]?.usage,
  ).toMatchObject({ inputTokens: expect.any(Number) });
  await pool.query(
    'DROP TRIGGER fail_draft_audit ON audit_events; DROP FUNCTION fail_draft_audit()',
  );
  await pool.query('UPDATE job_runs SET available_at=now() WHERE id=$1', [input.id]);
  await processDraft(input.data);
  const draft = schema('Draft', await store.tenant(org).draft(input.id));
  expect(draft.generation).toMatchObject({ accountedAttempts: 2, usageIncomplete: false });
  const usage = await pool.query<{ tokens: number }>(
    "SELECT sum((usage->>'inputTokens')::int)::int tokens FROM job_attempts WHERE job_id=$1",
    [input.id],
  );
  expect(draft.generation?.inputTokens).toBe(usage.rows[0]?.tokens);
});
test.each(['evidence', 'ticket', 'authority'] as const)(
  '%s changes during generation prevent a stale draft from publishing',
  async (change) => {
    const input = await createJob();
    const run: typeof pipeline.run = async (request, signal) => {
      const result = await pipeline.run(request, signal);
      if (change === 'evidence')
        await pool.query('UPDATE document_versions SET deleted_at=now() WHERE id=$1', [
          evalId('version:0:refund:2'),
        ]);
      if (change === 'ticket')
        await pool.query("UPDATE tickets SET subject='Changed question' WHERE id=$1", [
          input.ticket,
        ]);
      if (change === 'authority')
        await pool.query('UPDATE memberships SET active=false WHERE id=$1', [member]);
      return result;
    };
    try {
      await expect(draftProcessor({ pool, pipeline: { run } })(input.data)).rejects.toThrow(
        'EVIDENCE_CHANGED',
      );
    } finally {
      await pool.query('UPDATE memberships SET active=true WHERE id=$1', [member]);
      await pool.query('UPDATE document_versions SET deleted_at=NULL WHERE id=$1', [
        evalId('version:0:refund:2'),
      ]);
    }
    expect(await store.tenant(org).draft(input.id)).toBeUndefined();
  },
);
test('real BullMQ retries four provider failures, persists a DLQ, and an idempotent replay succeeds', async () => {
  const input = await createJob(),
    prefix = `draft-failure-${randomUUID()}`;
  const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const queue = new Queue(DRAFT_QUEUE, { connection, prefix, defaultJobOptions: ingestionOptions });
  const run = jest.fn<typeof pipeline.run>().mockRejectedValue(new EmbeddingProviderError(500));
  const handler = draftProcessor({ pool, pipeline: { run }, retryBaseMs: 10 });
  const worker = new Worker(DRAFT_QUEUE, (job) => handler(job.data), {
    connection,
    prefix,
    concurrency: 2,
    settings: { backoffStrategy: ingestionBackoff },
  });
  worker.on('error', () => undefined);
  try {
    await queue.add('draftSupportResponse', input.data);
    await until(
      () => job(input.id),
      (value) => value.status === 'failed',
    );
    expect(run).toHaveBeenCalledTimes(4);
    expect(schema('FailedJob', await store.tenant(org).failure(input.id))).toMatchObject({
      errorCategory: 'PROVIDER_UNAVAILABLE',
      replayEligible: true,
      attemptHistory: [1, 2, 3, 4].map((attempt) => expect.objectContaining({ attempt })),
    });
    const key = randomUUID(),
      replay = () =>
        store.mutate(actor, key, 'replay-draft', input.id, async (repo) => ({
          status: 202,
          body: { id: await repo.replay(input.id, actor.requestId, member) },
        }));
    const receipt = await replay();
    expect(await replay()).toEqual(receipt);
    const replayId = zId(receipt.body);
    await processDraft({ organizationId: org, jobId: replayId });
    expect((await job(replayId)).status).toBe('succeeded');
    expect(schema('FailedJob', await store.tenant(org).failure(input.id)).replayedAs).toBe(
      replayId,
    );
  } finally {
    await worker.close();
    await queue.close();
    connection.disconnect();
  }
});
function zId(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string')
    throw new Error('Invalid receipt');
  return value.id;
}
test('four abandoned claims exhaust the durable budget, and provider timeouts are finite', async () => {
  const input = await createJob();
  for (let attempt = 0; attempt < 4; attempt++) {
    const session = await DraftSession.open(pool, org, input.id);
    if (!session) throw new Error('Missing claim');
    try {
      expect(await session.claim()).toBe('run');
    } finally {
      await session.close();
    }
    await pool.query('UPDATE job_runs SET available_at=now() WHERE id=$1', [input.id]);
  }
  await expect(processDraft(input.data)).rejects.toThrow('WORKER_INTERRUPTED');
  expect((await job(input.id)).attempts).toBe(4);
  const timed = await createJob();
  await expect(
    draftProcessor({
      pool,
      timeoutMs: 30,
      pipeline: { run: async () => new Promise<RagDraft>(() => undefined) },
    })(timed.data),
  ).rejects.toThrow('requires retry');
  expect((await job(timed.id)).reasonCode).toBe('PROVIDER_TIMEOUT');
});
test('runtime dispatch uses scoped database authority under the nonowner worker role and closes cleanly', async () => {
  const input = await createJob();
  const role = `rh_draft_role_${randomUUID().replaceAll('-', '')}`;
  await pool.query(await readFile('infra/docker/runtime-grants.sql', 'utf8'));
  await pool.query(await readFile('infra/docker/worker-grants.sql', 'utf8'));
  await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT resolvehub_worker TO "${role}"`);
  const restrictedUrl = new URL(url);
  restrictedUrl.searchParams.set('options', `-c search_path=${namespace} -c role=${role}`);
  const restricted = createDatabase(restrictedUrl.toString(), { maxConnections: 8 }).pool;
  const env = parseWorkerEnv({
    ...process.env,
    DATABASE_URL: restrictedUrl.toString(),
    INGESTION_QUEUE_PREFIX: `runtime-${randomUUID()}`,
  });
  const runtime = createDraftRuntime(env, restricted, config);
  try {
    await until(() => Promise.resolve(runtime.ready()), Boolean);
    await until(
      () => job(input.id),
      (value) => value.status === 'succeeded',
    );
    expect((await restricted.query('SELECT id FROM draft_responses')).rowCount).toBe(0);
    await expect(
      restricted.query('SELECT * FROM drafting_dispatch_candidates()'),
    ).resolves.toBeDefined();
  } finally {
    await runtime.close();
    await restricted.end();
    await admin.query(`DROP OWNED BY "${role}"`);
    await admin.query(`DROP ROLE "${role}"`);
  }
  expect(runtime.ready()).toBe(false);
});

test('a transient failure leaves an explicit incomplete-usage flag on the recovered draft', async () => {
  const input = await createJob();
  const run = jest
    .fn<typeof pipeline.run>()
    .mockRejectedValueOnce(new EmbeddingProviderError(429, 100))
    .mockImplementation((request, signal) => pipeline.run(request, signal));
  const handler = draftProcessor({ pool, pipeline: { run } });
  await expect(handler(input.data)).rejects.toThrow('requires retry');
  await handler(input.data);
  expect(run).toHaveBeenCalledTimes(1);
  await pool.query('UPDATE job_runs SET available_at=now() WHERE id=$1', [input.id]);
  await handler(input.data);
  expect(schema('Draft', await store.tenant(org).draft(input.id)).generation).toMatchObject({
    usageIncomplete: true,
    accountedAttempts: 1,
  });
});

test('checkpoint database failure is categorized as persistence and never calls generation', async () => {
  const input = await createJob(),
    run = jest.fn<typeof pipeline.run>();
  try {
    await pool.query(
      `CREATE FUNCTION reject_draft_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id='${input.id}'::uuid AND NEW.stage='source' THEN RAISE EXCEPTION 'private checkpoint fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_draft_checkpoint BEFORE UPDATE ON job_attempts FOR EACH ROW EXECUTE FUNCTION reject_draft_checkpoint()`,
    );
    await expect(
      draftProcessor({ pool, pipeline: { run }, maxAttempts: 1 })(input.data),
    ).rejects.toThrow('DRAFT_PERSISTENCE_FAILED');
    expect(run).not.toHaveBeenCalled();
    expect(schema('FailedJob', await store.tenant(org).failure(input.id))).toMatchObject({
      errorCategory: 'DRAFT_PERSISTENCE_FAILED',
      attemptHistory: [expect.objectContaining({ stage: 'persistence', outcome: 'permanent' })],
    });
    expect(await store.tenant(org).draft(input.id)).toBeUndefined();
  } finally {
    await pool.query(
      'DROP TRIGGER IF EXISTS reject_draft_checkpoint ON job_attempts; DROP FUNCTION IF EXISTS reject_draft_checkpoint()',
    );
  }
});

test('unexpected generation error becomes a worker failure with durable diagnostic history', async () => {
  const input = await createJob();
  await expect(
    draftProcessor({
      pool,
      pipeline: {
        run: async () => {
          throw new Error('private adapter fault');
        },
      },
      maxAttempts: 1,
    })(input.data),
  ).rejects.toThrow('DRAFT_WORKER_FAILED');
  expect(schema('FailedJob', await store.tenant(org).failure(input.id))).toMatchObject({
    errorCategory: 'DRAFT_WORKER_FAILED',
    attemptHistory: [expect.objectContaining({ stage: 'source' })],
  });
  expect(await store.tenant(org).draft(input.id)).toBeUndefined();
});

test('session failure without a stage preserves the prior checkpoint for recovery', async () => {
  const input = await createJob(),
    session = await DraftSession.open(pool, org, input.id);
  if (!session) throw new Error('Missing fixture session');
  try {
    expect(await session.claim()).toBe('run');
    await session.checkpoint('retrieval');
    expect(await session.fail('WORKER_INTERRUPTED', false, 1)).toBe(false);
    expect(
      (await pool.query('SELECT stage,outcome FROM job_attempts WHERE job_id=$1', [input.id])).rows,
    ).toEqual([{ stage: 'retrieval', outcome: 'transient' }]);
  } finally {
    await session.close();
  }
});
