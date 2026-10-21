import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase, queueSnapshot } from '@resolvehub/db';
import { INGESTION_QUEUE } from '@resolvehub/contracts';
import { z } from 'zod';
import { loadEvaluationCorpus, readEvaluationFixtures } from '../packages/ai/evals/runner.js';
import { downloadK6 } from './k6.js';

// Called ONLY by the Testcontainers runner; never loads .env or paid providers.
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.AI_PROVIDER !== 'mock' ||
  !process.env.DATABASE_URL ||
  !process.env.REDIS_URL ||
  !process.env.S3_ENDPOINT
)
  throw new Error('Use pnpm perf:run for isolated synthetic performance verification');
const pool = createDatabase(process.env.DATABASE_URL, { maxConnections: 12 }).pool;
const children: ChildProcess[] = [];
const logs: Awaited<ReturnType<typeof open>>[] = [];
let directory: string | undefined;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill('SIGTERM');
  });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Cannot allocate benchmark port');
  return address.port;
}
async function start(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const log = await open(`test-results/performance-${name}.log`, 'w', 0o600);
  logs.push(log);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  return child;
}
async function ready(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 150 && !interrupted; attempt++) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error('Benchmark application exited; inspect performance logs');
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* bounded startup */
    }
    await delay(100);
  }
  throw new Error('Benchmark application readiness timed out');
}
async function run(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { env, stdio: 'inherit' });
  children.push(child);
  const [code] = await once(child, 'exit');
  children.splice(children.indexOf(child), 1);
  assert.equal(code, 0, 'k6 thresholds must pass');
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
async function queryTrace(traceId: string, expected: string[]) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`http://127.0.0.1:3200/api/traces/${traceId}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const value: unknown = await response.json();
      const values = strings(value);
      if (expected.every((name) => values.includes(name))) return value;
    }
    await delay(300);
  }
  throw new Error(`Trace missing expected operations: ${expected.join(', ')}`);
}
async function main() {
  await mkdir('test-results', { recursive: true });
  directory = await mkdtemp(join(tmpdir(), 'resolvehub-performance-'));
  for (const url of [
    'http://127.0.0.1:13133/',
    'http://127.0.0.1:3200/ready',
    'http://127.0.0.1:9090/-/ready',
  ])
    assert.ok(
      (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok,
      'Start pnpm observability:up first',
    );
  const fixtures = await readEvaluationFixtures();
  await loadEvaluationCorpus(pool, fixtures.corpus);
  const tokens: Record<string, string> = {};
  for (const organizationId of new Set(fixtures.cases.map((item) => item.organizationId))) {
    const membershipId = randomUUID(),
      token = `rh_${randomBytes(32).toString('base64url')}`;
    tokens[organizationId] = token;
    await pool.query(
      "INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,'synthetic-performance@example.test','admin')",
      [membershipId, organizationId],
    );
    await pool.query(
      "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), organizationId, membershipId],
    );
  }
  for (const file of ['runtime-grants.sql', 'worker-grants.sql'])
    await pool.query(await readFile(`infra/docker/${file}`, 'utf8'));
  const apiPassword = randomBytes(24).toString('hex'),
    workerPassword = randomBytes(24).toString('hex');
  await pool.query(
    `CREATE ROLE performance_api LOGIN PASSWORD '${apiPassword}' NOSUPERUSER NOBYPASSRLS; GRANT resolvehub_runtime TO performance_api; CREATE ROLE performance_worker LOGIN PASSWORD '${workerPassword}' NOSUPERUSER NOBYPASSRLS; GRANT resolvehub_worker TO performance_worker`,
  );
  const apiDatabaseUrl = new URL(process.env.DATABASE_URL ?? '');
  apiDatabaseUrl.username = 'performance_api';
  apiDatabaseUrl.password = apiPassword;
  const workerDatabaseUrl = new URL(process.env.DATABASE_URL ?? '');
  workerDatabaseUrl.username = 'performance_worker';
  workerDatabaseUrl.password = workerPassword;
  const binary = await downloadK6(directory);
  const apiPort = await freePort(),
    webPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`,
    workerUrl = process.env.WORKER_URL;
  if (!workerUrl) throw new Error('Worker URL missing');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    API_PORT: String(apiPort),
    API_URL: apiUrl,
    PORT: String(webPort),
    WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    OTEL_METRIC_EXPORT_INTERVAL_MS: '1000',
  };
  const api = await start('api', ['services/api/dist/main.js'], {
    ...env,
    DATABASE_URL: apiDatabaseUrl.href,
  });
  const worker = await start('worker', ['services/worker/dist/main.js'], {
    ...env,
    DATABASE_URL: workerDatabaseUrl.href,
  });
  await ready(`${apiUrl}/health/ready`, api);
  await ready(`${workerUrl}/health/ready`, worker);
  const web = await start('web', ['scripts/start-web.mjs'], { ...env, NODE_ENV: 'production' });
  await ready(`http://127.0.0.1:${webPort}/api/health`, web);
  const webTraceId = randomBytes(16).toString('hex');
  const parent = (id: string) => `00-${id}-${randomBytes(8).toString('hex')}-01`;
  const health = await fetch(`http://127.0.0.1:${webPort}/api/status`, {
    headers: {
      traceparent: parent(webTraceId),
      baggage: 'customer=private-canary@example.test',
      tracestate: 'secret=private-canary',
    },
  });
  assert.equal(z.object({ status: z.string() }).parse(await health.json()).status, 'ready');
  const webTrace = await queryTrace(webTraceId, [
    'web.status',
    'http.request',
    'resolvehub-web',
    'resolvehub-api',
    'resolvehub-worker',
  ]);
  const organizationId = fixtures.cases[0]?.organizationId,
    token = organizationId ? tokens[organizationId] : undefined;
  if (!organizationId || !token) throw new Error('Missing synthetic identity');
  const s3Endpoint = process.env.S3_ENDPOINT;
  if (!s3Endpoint) throw new Error('S3_ENDPOINT missing');
  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
  });
  const bucket = process.env.S3_BUCKET ?? 'resolvehub-verification';
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const canary = 'CUSTOMER_CANARY_private-person@example.test_AUTH_BEARER_private-token';
    const bytes = Buffer.from(
      `Diagnostic synthetic record: ${canary}. This record contains no support policy.`,
    );
    const objectKey = `organizations/${organizationId}/uploads/${randomUUID()}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: bytes,
        ContentType: 'text/plain',
      }),
    );
    const ingestionInput = {
      title: canary,
      objectKey,
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const traceId = randomBytes(16).toString('hex');
    const response = await fetch(`${apiUrl}/v1/documents/ingestions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
        traceparent: parent(traceId),
      },
      body: JSON.stringify(ingestionInput),
    });
    assert.equal(response.status, 202);
    const receipt = z.object({ jobId: z.uuid() }).parse(await response.json());
    await completed(apiUrl, token, receipt.jobId);
    const ingestTrace = await queryTrace(traceId, [
      'http.request',
      'queue.publish',
      'queue.consume',
      'ingestion.download',
      'ingestion.extract',
      'ingestion.chunk',
      'ingestion.embed',
      'ingestion.publish',
      'postgresql.query',
      'redis.command',
    ]);
    const traceSchema = z.object({
      batches: z.array(
        z.object({
          resource: z.object({
            attributes: z.array(
              z.object({ key: z.string(), value: z.object({ stringValue: z.string() }) }),
            ),
          }),
        }),
      ),
    });
    const workerResource = traceSchema
      .parse(ingestTrace)
      .batches.find((batch) =>
        batch.resource.attributes.some(
          (attribute) =>
            attribute.key === 'service.name' && attribute.value.stringValue === 'resolvehub-worker',
        ),
      );
    const workerInstance = workerResource?.resource.attributes.find(
      (attribute) => attribute.key === 'service.instance.id',
    )?.value.stringValue;
    assert.ok(
      workerInstance && z.uuid().safeParse(workerInstance).success,
      'Trace identifies this worker instance',
    );
    const raw = JSON.stringify([webTrace, ingestTrace]);
    for (const marker of [
      canary,
      token,
      objectKey,
      organizationId,
      'private-canary@example.test',
      'private-canary',
    ])
      assert.ok(!raw.includes(marker), 'Exported traces must not contain private fields');
    const configPath = join(directory, 'load-config.json');
    const draftTraceId = randomBytes(16).toString('hex');
    await writeFile(
      configPath,
      JSON.stringify({
        apiUrl,
        tokens,
        draftTraceparent: parent(draftTraceId),
        cases: fixtures.cases.filter((item) => item.category === 'answerable'),
        saturation: { token, input: ingestionInput },
      }),
      { mode: 0o600 },
    );
    const draftPath = resolve('test-results/k6-drafts.json'),
      saturationPath = resolve('test-results/k6-saturation.json');
    await run(binary, ['run', 'tests/load/resolvehub.js'], {
      ...env,
      RESOLVEHUB_LOAD_CONFIG: configPath,
      RESOLVEHUB_SCENARIO: 'drafts',
      RESOLVEHUB_SUMMARY_PATH: draftPath,
    });
    const draftTrace = await queryTrace(draftTraceId, [
      'http.request',
      'queue.publish',
      'queue.consume',
      'rag.draft',
      'rag.embedding',
      'rag.retrieval',
      'rag.generation',
      'graphql.request',
      'graphql.resolve',
      'postgresql.query',
      'redis.command',
    ]);
    const draftRaw = JSON.stringify(draftTrace);
    for (const marker of [token, organizationId, 'load@example.test', fixtures.cases[0]?.question])
      if (marker) assert.ok(!draftRaw.includes(marker), 'Draft traces must omit private inputs');
    const redis = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: 1 });
    redis.on('error', () => undefined);
    const queue = new Queue(INGESTION_QUEUE, {
      connection: redis,
      prefix: process.env.INGESTION_QUEUE_PREFIX ?? 'verification',
    });
    try {
      await queue.pause();
      await run(binary, ['run', 'tests/load/resolvehub.js'], {
        ...env,
        RESOLVEHUB_LOAD_CONFIG: configPath,
        RESOLVEHUB_SCENARIO: 'saturation',
        RESOLVEHUB_SUMMARY_PATH: saturationPath,
      });
      const snapshot = await queueSnapshot(pool);
      assert.equal(snapshot.find((row) => row.job_kind === 'document_ingestion')?.pending, 1000);
      await delay(7000); // A metric export and Prometheus scrape; queue stays safely paused.
      const metricQuery = `max(resolvehub_queue_pending{job_kind="document_ingestion",service_instance_id="${workerInstance}"})`;
      const metricsResponse = await fetch(
        `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(metricQuery)}`,
      );
      const metricResult = z
        .object({
          status: z.literal('success'),
          data: z.object({
            result: z.array(z.object({ value: z.tuple([z.number(), z.string()]) })),
          }),
        })
        .parse(await metricsResponse.json());
      assert.equal(
        metricResult.data.result[0]?.value[1],
        '1000',
        'Real OTLP metrics must reach Prometheus',
      );
      const report = {
        generatedAt: new Date().toISOString(),
        provider: 'mock',
        embeddingModel: 'resolvehub-synthetic-sha256-v1',
        environment: {
          os: platform(),
          architecture: arch(),
          cpus: cpus().length,
          memoryGiB: totalmem() / 1024 ** 3,
          node: process.version,
          k6: '2.3.0',
          workerConcurrency: 2,
          draftRateLimitPerSecond: 10,
          telemetrySampleRatio: 1,
        },
        fixtureDigest: fixtures.digest,
        fixtureDocuments: new Set(fixtures.corpus.map((row) => row.documentId)).size,
        fixtureChunks: fixtures.corpus.length,
        drafts: JSON.parse(await readFile(draftPath, 'utf8')) as unknown,
        saturation: JSON.parse(await readFile(saturationPath, 'utf8')) as unknown,
        traceVerification: {
          webTraceId,
          ingestionTraceId: traceId,
          draftTraceId,
          draftingStages: true,
          propagatedAcrossThreeServices: true,
          ingestionStages: true,
          postgresAndRedisAutoInstrumentation: true,
          privacyCanariesAbsent: true,
        },
        operationalSnapshot: snapshot,
        prometheusQueuePending: metricResult.data.result[0]?.value[1],
      };
      await writeFile(
        'test-results/performance-report.json',
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.info(
        'Measured k6 report: test-results/performance-report.json; propagation, privacy and Prometheus export verified.',
      );
    } finally {
      await queue.close();
      redis.disconnect();
    }
  } finally {
    s3.destroy();
  }
}
async function completed(apiUrl: string, token: string, jobId: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(`${apiUrl}/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const job = z.object({ status: z.string() }).parse(await response.json());
    if (job.status === 'succeeded') return;
    if (job.status === 'failed') throw new Error('Synthetic trace verification ingestion failed');
    await delay(100);
  }
  throw new Error('Synthetic trace verification ingestion timed out');
}
try {
  await main();
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    await once(child, 'exit');
    clearTimeout(timer);
  }
  for (const log of logs) await log.close();
  await pool.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
