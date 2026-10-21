import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '@resolvehub/db';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

if (
  process.env.NODE_ENV !== 'test' ||
  !process.env.DATABASE_URL ||
  process.env.AI_PROVIDER !== 'mock'
)
  throw new Error('Use pnpm test:dashboard with isolated synthetic infrastructure');
const pool = createDatabase(process.env.DATABASE_URL).pool;
const children: ChildProcess[] = [];
const logs: Awaited<ReturnType<typeof open>>[] = [];
const directory = await mkdtemp(join(tmpdir(), 'resolvehub-dashboard-'));
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  return address.port;
}
async function start(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const log = await open(`test-results/dashboard-${name}.log`, 'w', 0o600);
  logs.push(log);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  return child;
}
async function ready(url: string, child: ChildProcess) {
  for (let n = 0; n < 150; n++) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error('Dashboard application exited; inspect its private test log');
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* bounded startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Dashboard readiness timed out');
}
try {
  await mkdir('test-results', { recursive: true });
  const credentials: Record<string, string> = {};
  const organizations = { a: randomUUID(), b: randomUUID() };
  const tickets = { a: randomUUID(), b: randomUUID() };
  for (const [name, org, role] of [
    ['adminA', organizations.a, 'admin'],
    ['adminB', organizations.b, 'admin'],
    ['analyst', organizations.a, 'analyst'],
  ] as const) {
    await pool.query(
      'INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',
      [org, `Synthetic dashboard ${org === organizations.a ? 'A' : 'B'}`],
    );
    const member = randomUUID(),
      token = `rh_${randomBytes(32).toString('base64url')}`;
    credentials[name] = token;
    await pool.query(
      'INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,$3,$4)',
      [member, org, `${name}@example.test`, role],
    );
    await pool.query(
      "INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), org, member],
    );
  }
  for (const name of ['a', 'b'] as const)
    await pool.query(
      "INSERT INTO tickets(id,organization_id,subject,customer_email) VALUES($1,$2,$3,'synthetic@example.test')",
      [tickets[name], organizations[name], `PRIVATE_ORGANIZATION_${name.toUpperCase()}_TICKET`],
    );
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
    await storage.send(
      new CreateBucketCommand({ Bucket: process.env.S3_BUCKET ?? 'resolvehub-verification' }),
    );
  } finally {
    storage.destroy();
  }
  const apiPort = await freePort(),
    webPort = await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    API_PORT: String(apiPort),
    API_URL: `http://127.0.0.1:${apiPort}`,
    WEB_ORIGIN: webOrigin,
    PORT: String(webPort),
    OTEL_ENABLED: 'false',
    DASHBOARD_LOCAL_DEMO: 'false',
  };
  const api = await start('api', ['services/api/dist/main.js'], env),
    worker = await start('worker', ['services/worker/dist/main.js'], env);
  await ready(`${env.API_URL}/health/ready`, api);
  await ready(`${env.WORKER_URL}/health/ready`, worker);
  const web = await start('web', ['scripts/start-web.mjs'], { ...env, NODE_ENV: 'production' });
  await ready(`${webOrigin}/api/health`, web);
  const configPath = join(directory, 'fixtures.json');
  await writeFile(configPath, JSON.stringify({ credentials, tickets }), { mode: 0o600 });
  const browser = spawn('pnpm', ['exec', 'playwright', 'test'], {
    env: { ...env, RESOLVEHUB_DASHBOARD_TEST_CONFIG: configPath },
    stdio: 'inherit',
  });
  children.push(browser);
  const [code] = await once(browser, 'exit');
  process.exitCode = typeof code === 'number' ? code : 1;
  if (code === 0) {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) FROM ticket_messages WHERE organization_id=$1 AND author='agent' AND delivery_status='internal' AND source_draft_id IS NOT NULL",
      [organizations.a],
    );
    assert.equal(
      result.rows[0]?.count,
      '2',
      'Both desktop and mobile approvals must persist one internal reply',
    );
    console.info(
      'Browser workflows and persisted internal-only replies verified; no external delivery adapter configured.',
    );
  }
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
  await rm(directory, { recursive: true, force: true });
}
