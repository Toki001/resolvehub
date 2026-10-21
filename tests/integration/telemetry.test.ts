import { jest } from '@jest/globals';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createDatabase, jobTraceContext } from '@resolvehub/db';

jest.setTimeout(30000);
if (!process.env.DATABASE_URL) throw new Error('Use the isolated integration runner');
const pool = createDatabase(process.env.DATABASE_URL).pool;
const organization = randomUUID(),
  foreign = randomUUID(),
  membership = randomUUID();
const token = `rh_${randomBytes(32).toString('base64url')}`;
const canary = 'CUSTOMER_CANARY_private-person@example.test_bearer-private';
const bodies: Buffer[] = [];
const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    if (bodies.length < 30) bodies.push(Buffer.concat(chunks));
    response.writeHead(503).end();
  });
});
let application: ChildProcess | undefined, base: string;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
beforeAll(async () => {
  await pool.query(
    "INSERT INTO organizations(id,name) VALUES($1,'Telemetry synthetic'),($2,'Foreign synthetic')",
    [organization, foreign],
  );
  await pool.query(
    "INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,'telemetry@example.test','admin')",
    [membership, organization],
  );
  await pool.query(
    "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [createHash('sha256').update(token).digest('hex'), organization, membership],
  );
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  if (!address || typeof address === 'string') throw new Error('Receiver port missing');
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const apiAddress = portProbe.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('API port missing');
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  base = `http://127.0.0.1:${apiAddress.port}`;
  application = spawn(process.execPath, ['services/api/dist/main.js'], {
    env: {
      ...process.env,
      API_PORT: String(apiAddress.port),
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
      OTEL_METRIC_EXPORT_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (application.exitCode !== null) throw new Error('Instrumented API exited');
    try {
      if ((await fetch(`${base}/health/ready`)).ok) return;
    } catch {
      /* bounded startup */
    }
    await sleep(100);
  }
  throw new Error('Instrumented API did not start');
});
afterAll(async () => {
  if (application?.exitCode === null && !application.signalCode) {
    const timer = setTimeout(() => application?.kill('SIGKILL'), 12000);
    application.kill('SIGTERM');
    await once(application, 'exit');
    clearTimeout(timer);
  }
  receiver.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])', [[organization, foreign]]);
  await pool.end();
});
test('collector failure cannot block mutations; OTLP payloads redact PII and context persists transactionally', async () => {
  const traceId = randomBytes(16).toString('hex'),
    traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
    traceparent,
    baggage: `email=${canary}`,
    tracestate: `private=${canary}`,
  };
  const started = performance.now();
  const created = await fetch(`${base}/v1/tickets?private=${canary}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subject: canary,
      customerEmail: 'private-person@example.test',
      message: canary,
    }),
  });
  expect(created.status).toBe(201);
  expect(performance.now() - started).toBeLessThan(2000);
  const ticket = z.object({ id: z.uuid() }).parse(await created.json());
  assert.equal(typeof ticket.id, 'string');
  const accepted = await fetch(`${base}/v1/tickets/${ticket.id}/drafts`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    body: '{}',
  });
  expect(accepted.status).toBe(202);
  const receipt = z.object({ jobId: z.uuid() }).parse(await accepted.json());
  assert.equal(typeof receipt.jobId, 'string');
  const stored = await jobTraceContext(pool, organization, String(receipt.jobId));
  expect(stored?.split('-')[1]).toBe(traceId);
  expect(await jobTraceContext(pool, foreign, String(receipt.jobId))).toBeUndefined();
  await sleep(3500);
  expect(bodies.length).toBeGreaterThan(0);
  const payload = Buffer.concat(bodies).toString('utf8');
  for (const value of [
    canary,
    token,
    organization,
    'private-person@example.test',
    'db.statement',
    'http.request.header.authorization',
    'url.full',
    'baggage',
    'tracestate',
  ])
    expect(payload).not.toContain(value);
  expect(payload).toContain('postgresql.query');
  expect(payload).toContain('http.request');
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
});
test('database metadata rejects non-trace fields and API roles cannot read global queue aggregates', async () => {
  await expect(
    pool.query(
      "INSERT INTO job_runs(id,organization_id,kind,request_id,payload,trace_context) VALUES($1,$2,'ticket_webhook',$3,'{}'::jsonb,$4)",
      [randomUUID(), organization, randomUUID(), JSON.stringify({ email: canary })],
    ),
  ).rejects.toThrow();
  for (const file of ['runtime-grants.sql', 'worker-grants.sql'])
    await pool.query(await readFile(`infra/docker/${file}`, 'utf8'));
  const result = await pool.query<{ api: boolean; worker: boolean }>(
    "SELECT has_function_privilege('resolvehub_runtime','operational_queue_snapshot()','execute') api, has_function_privilege('resolvehub_worker','operational_queue_snapshot()','execute') worker",
  );
  expect(result.rows[0]).toEqual({ api: false, worker: true });
});
