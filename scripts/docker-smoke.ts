import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, Network, Wait } from 'testcontainers';
import type { StartedTestContainer, StartedNetwork } from 'testcontainers';
import { createDatabase } from '@resolvehub/db';
import { z } from 'zod';

const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (await exec('docker', args, { timeout: 180_000 })).stdout.trim();
process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
const dependencies: StartedTestContainer[] = [];
const applications: string[] = [];
let network: StartedNetwork | undefined;
let directory: string | undefined;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    interrupted = true;
  });

async function start(container: GenericContainer) {
  const name = `resolvehub-image-dependency-${randomUUID()}`;
  let started: StartedTestContainer;
  try {
    started = await container.withName(name).withStartupTimeout(120_000).start();
  } catch (error) {
    await docker('rm', '--force', '--volumes', name).catch(() =>
      console.error('Cannot remove failed verification container'),
    );
    throw error;
  }
  dependencies.push(started);
  if (interrupted) throw new Error('Container verification interrupted');
  return started;
}
async function secret(name: string, value: string) {
  if (!directory) throw new Error('Secret directory missing');
  const path = join(directory, name);
  await writeFile(path, value, { mode: 0o444 });
  return ['--mount', `type=bind,source=${path},target=/run/secrets/${name},readonly`];
}
async function ready(url: string, container: string) {
  for (let attempt = 0; attempt < 120 && !interrupted; attempt++) {
    const state = await docker('inspect', '--format', '{{.State.Running}}', container);
    if (state !== 'true') throw new Error('Application image exited during startup');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      /* bounded startup probe */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Application image failed readiness');
}
async function app(
  component: 'api' | 'worker' | 'web',
  port: number,
  env: Record<string, string>,
  mounts: string[],
) {
  if (!network || interrupted) throw new Error('Verification network unavailable');
  const name = `rh-image-${component}-${randomUUID()}`;
  const image = `resolvehub-ci/${component}:milestone07`;
  assert.equal(
    await docker('image', 'inspect', '--format', '{{.Config.User}}', image),
    '10001:10001',
  );
  applications.push(name);
  const id = await docker(
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    network.getName(),
    '--network-alias',
    component,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--init',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    ...(component === 'web'
      ? ['--tmpfs', '/app/apps/web/.next/cache:rw,noexec,nosuid,size=64m,uid=10001,gid=10001']
      : []),
    '-p',
    `127.0.0.1::${port}`,
    ...mounts,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image,
  );
  const published = await docker('port', id, `${port}/tcp`);
  const base = `http://${published}`;
  await ready(`${base}${component === 'web' ? '/api/health' : '/health/ready'}`, id);
  assert.equal(await docker('exec', id, 'id', '-u'), '10001');
  await docker('exec', id, 'node', 'healthcheck.mjs');
  await assert.rejects(
    docker('exec', id, 'node', '-e', "require('fs').writeFileSync('/app/write-probe','denied')"),
  );
  console.info(`${component}: non-root, read-only, secret mounts, health and readiness verified`);
  return { base, id };
}
async function main() {
  directory = await mkdtemp(join(tmpdir(), 'resolvehub-image-smoke-'));
  network = await new Network().start();
  const postgres = await start(
    new GenericContainer(
      'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d',
    )
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .withEnvironment({
        POSTGRES_USER: 'verification',
        POSTGRES_PASSWORD: 'synthetic-test-only',
        POSTGRES_DB: 'verification',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2)),
  );
  const redis = await start(
    new GenericContainer(
      'redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
    )
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections')),
  );
  const minioImage = 'resolvehub/minio:RELEASE.2025-10-15T17-29-55Z';
  try {
    await docker('image', 'inspect', minioImage);
  } catch {
    await exec('docker', ['build', '--tag', minioImage, 'infra/docker/minio'], {
      timeout: 600_000,
      maxBuffer: 5 * 1024 * 1024,
    });
  }
  await start(
    new GenericContainer(minioImage)
      .withNetwork(network)
      .withNetworkAliases('minio')
      .withEnvironment({
        MINIO_ROOT_USER: 'verification',
        MINIO_ROOT_PASSWORD: 'synthetic-storage-only',
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000)),
  );
  const adminUrl = `postgresql://verification:synthetic-test-only@${postgres.getHost()}:${postgres.getMappedPort(5432)}/verification`;
  const pool = createDatabase(adminUrl).pool;
  try {
    await pool.query('CREATE EXTENSION vector; CREATE EXTENSION pgcrypto');
    const adminMount = await secret(
      'migration-db',
      'postgresql://verification:synthetic-test-only@postgres:5432/verification',
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const migrationName = `rh-image-migration-${randomUUID()}`;
      applications.push(migrationName);
      const output = await docker(
        'run',
        '--name',
        migrationName,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--network',
        network.getName(),
        ...adminMount,
        '--env',
        'DATABASE_URL_FILE=/run/secrets/migration-db',
        'resolvehub-ci/api:milestone07',
        'migrate.mjs',
        '--grants',
      );
      assert.match(output, attempt === 0 ? /Applied: 0001_/ : /already current/);
    }
    console.info('Image migration runner: clean install, runtime grants and repeat apply verified');
    await pool.query(
      "CREATE ROLE ci_api LOGIN PASSWORD 'synthetic-api-only' NOSUPERUSER NOBYPASSRLS; GRANT resolvehub_runtime TO ci_api; CREATE ROLE ci_worker LOGIN PASSWORD 'synthetic-worker-only' NOSUPERUSER NOBYPASSRLS; GRANT resolvehub_worker TO ci_worker",
    );
    const common = {
      REDIS_URL_FILE: '/run/secrets/redis',
      S3_ENDPOINT: 'http://minio:9000',
      EMBEDDING_MODEL: 'resolvehub-synthetic-sha256-v1',
      EMBEDDING_DIMENSIONS: '64',
    };
    const redisMount = await secret('redis', 'redis://redis:6379');
    const apiMounts = [
      ...redisMount,
      ...(await secret(
        'api-db',
        'postgresql://ci_api:synthetic-api-only@postgres:5432/verification',
      )),
      ...(await secret('api-key', randomBytes(32).toString('hex'))),
    ];
    const workerMounts = [
      ...redisMount,
      ...(await secret(
        'worker-db',
        'postgresql://ci_worker:synthetic-worker-only@postgres:5432/verification',
      )),
      ...(await secret('s3-access', 'verification')),
      ...(await secret('s3-secret', 'synthetic-storage-only')),
    ];
    const api = await app(
      'api',
      3001,
      {
        ...common,
        DATABASE_URL_FILE: '/run/secrets/api-db',
        API_SECRET_KEY_FILE: '/run/secrets/api-key',
        WEB_ORIGIN: 'http://localhost:3000',
      },
      apiMounts,
    );
    const worker = await app(
      'worker',
      3002,
      {
        ...common,
        DATABASE_URL_FILE: '/run/secrets/worker-db',
        S3_ACCESS_KEY_ID_FILE: '/run/secrets/s3-access',
        S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/s3-secret',
        AI_PROVIDER: 'mock',
        DRAFT_PROVIDER: 'mock',
        DRAFT_MODEL: 'resolvehub-extractive-mock-v1',
      },
      workerMounts,
    );
    const web = await app(
      'web',
      3000,
      { API_URL: 'http://api:3001', WORKER_URL: 'http://worker:3002' },
      [],
    );
    const status = (await fetch(`${web.base}/api/status`).then((response) =>
      response.json(),
    )) as unknown;
    assert.equal(
      typeof status === 'object' && status !== null && 'status' in status && status.status,
      'ready',
    );
    for (const path of ['/tickets', '/knowledge', '/review', '/settings']) {
      const response = await fetch(`${web.base}${path}`);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      const asset =
        /src="([^"\s]+\/_next\/static\/[^"\s]+\.js)"/.exec(html)?.[1] ??
        /src="(\/_next\/static\/[^"\s]+\.js)"/.exec(html)?.[1];
      assert.ok(asset, 'Standalone server must include browser assets');
      assert.equal((await fetch(new URL(asset, web.base))).status, 200);
    }
    const organization = randomUUID(),
      membership = randomUUID(),
      token = `rh_${randomBytes(32).toString('base64url')}`;
    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic image smoke')", [
      organization,
    ]);
    await pool.query(
      "INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,'image@example.test','admin')",
      [membership, organization],
    );
    await pool.query(
      "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), organization, membership],
    );
    const response = await fetch(`${api.base}/v1/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({
        subject: 'Image smoke',
        customerEmail: 'synthetic@example.test',
        message: 'Synthetic production container verification.',
      }),
    });
    assert.equal(response.status, 201, 'Authenticated persisted ticket creation with runtime role');
    const graph = await fetch(`${api.base}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ tickets(first: 1) { edges { node { subject } } } }' }),
    });
    assert.equal(graph.status, 200);
    const result = z
      .object({
        data: z.unknown(),
        extensions: z.object({ requestId: z.uuid() }),
      })
      .strict()
      .parse(await graph.json());
    assert.deepEqual(result.data, { tickets: { edges: [{ node: { subject: 'Image smoke' } }] } });
    assert.equal(result.extensions.requestId, graph.headers.get('x-request-id'));
    await exec('pnpm', ['exec', 'tsx', 'scripts/smoke.ts'], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        WEB_ORIGIN: web.base,
        API_URL: api.base,
        WORKER_URL: worker.base,
        REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      },
      timeout: 45_000,
    }).then((result) => console.info(result.stdout.trim()));
    await docker('stop', '--time', '20', worker.id);
    assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', worker.id), '0');
    console.info(
      'REST, GraphQL, dashboard assets, worker queue roundtrip and graceful shutdown verified',
    );
  } finally {
    await pool.end();
  }
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Container smoke failed');
  for (const id of applications)
    console.error(
      await docker('logs', '--tail', '25', id).catch(() => 'Cannot read container logs'),
    );
  process.exitCode = 1;
} finally {
  for (const id of applications.reverse())
    await docker('rm', '--force', '--volumes', id).catch(() => {
      process.exitCode = 1;
    });
  for (const container of dependencies.reverse())
    await container.stop().catch(() => {
      process.exitCode = 1;
    });
  if (network) await network.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}
