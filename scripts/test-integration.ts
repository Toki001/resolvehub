import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, open } from 'node:fs/promises';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { createDatabase, migrate } from '@resolvehub/db';

// Never load .env: tests own their credentials, data, ports and provider mode.
process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
const containers: StartedTestContainer[] = [];
const children: ChildProcess[] = [];
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill('SIGTERM');
  });

async function run(command: string, args: string[], env = process.env): Promise<number> {
  const child = spawn(command, args, { env, stdio: 'inherit' });
  children.push(child);
  try {
    const [code] = await once(child, 'exit');
    return typeof code === 'number' ? code : 1;
  } finally {
    children.splice(children.indexOf(child), 1);
  }
}
async function start(container: GenericContainer) {
  const started = await container.withStartupTimeout(90000).start();
  containers.push(started);
  if (interrupted) throw new Error('Verification interrupted');
  return started;
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  server.close();
  if (!address || typeof address === 'string') throw new Error('Cannot allocate test port');
  return address.port;
}
async function waitReady(url: string, worker: ChildProcess) {
  for (let attempt = 0; attempt < 100 && !interrupted; attempt++) {
    if (worker.exitCode !== null || worker.signalCode !== null)
      throw new Error('Test worker exited; inspect test-results/worker.log');
    try {
      const response = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      /* startup probe */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test worker did not become ready; inspect test-results/worker.log');
}

async function main() {
  const build = await run('pnpm', [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@resolvehub/api...',
    '--filter=@resolvehub/worker...',
  ]);
  if (build !== 0) return build;
  const postgres = await start(
    new GenericContainer(
      'pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d',
    )
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
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections')),
  );
  // Uses the same source-built, release-pinned image as Compose. No host volumes.
  const image = 'resolvehub/minio:RELEASE.2025-10-15T17-29-55Z';
  const inspect = spawn('docker', ['image', 'inspect', image], { stdio: 'ignore' });
  const [imageStatus] = await once(inspect, 'exit');
  if (imageStatus !== 0) {
    const built = await run('docker', ['build', '--tag', image, 'infra/docker/minio']);
    if (built !== 0) return built;
  }
  const minio = await start(
    new GenericContainer(image)
      .withEnvironment({
        MINIO_ROOT_USER: 'verification',
        MINIO_ROOT_PASSWORD: 'synthetic-storage-only',
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000)),
  );
  const databaseUrl = `postgresql://verification:synthetic-test-only@${postgres.getHost()}:${postgres.getMappedPort(5432)}/verification`;
  const { pool } = createDatabase(databaseUrl);
  try {
    await pool.query(
      'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto',
    );
    await migrate(pool, new URL('../packages/db/migrations/', import.meta.url));
  } finally {
    await pool.end();
  }
  const workerPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    TESTCONTAINERS_RYUK_DISABLED: 'true',
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
    DATABASE_URL: databaseUrl,
    REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    S3_ENDPOINT: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
    S3_ACCESS_KEY_ID: 'verification',
    S3_SECRET_ACCESS_KEY: 'synthetic-storage-only',
    S3_BUCKET: 'resolvehub-verification',
    S3_REGION: 'us-east-1',
    API_SECRET_KEY: 'a'.repeat(64),
    API_HOST: '127.0.0.1',
    API_PORT: '1',
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    WORKER_HOST: '127.0.0.1',
    WORKER_PORT: String(workerPort),
    WORKER_URL: `http://127.0.0.1:${workerPort}`,
    WORKER_CONCURRENCY: '2',
    INGESTION_QUEUE_PREFIX: 'verification',
    EMBEDDING_MODEL: 'resolvehub-synthetic-sha256-v1',
    EMBEDDING_DIMENSIONS: '64',
    AI_PROVIDER: 'mock',
  };
  await mkdir('test-results', { recursive: true });
  const log = await open('test-results/worker.log', 'w');
  try {
    const worker = spawn(process.execPath, ['services/worker/dist/main.js'], {
      env,
      stdio: ['ignore', log.fd, log.fd],
    });
    children.push(worker);
    await waitReady(env.WORKER_URL ?? '', worker);
    const coverage = process.argv.includes('--coverage');
    return await run(
      process.execPath,
      [
        '--experimental-vm-modules',
        'node_modules/jest/bin/jest.js',
        '--config',
        coverage ? 'tests/jest.coverage.config.cjs' : 'tests/jest.integration.config.cjs',
        '--runInBand',
        '--json',
        '--outputFile=test-results/jest-results.json',
        ...process.argv.slice(2).filter((arg) => arg !== '--coverage'),
      ],
      env,
    );
  } finally {
    await log.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Verification infrastructure failed');
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
    try {
      await once(child, 'exit');
    } finally {
      clearTimeout(deadline);
    }
  }
  for (const container of containers.reverse()) {
    try {
      await container.stop();
    } catch {
      console.error('Failed to stop a verification container; inspect Docker resources.');
      process.exitCode = 1;
    }
  }
}
