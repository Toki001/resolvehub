import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createDatabase } from '@resolvehub/db';
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';

// Explicit local provisioning only; no registration route, production fallback,
// real customer data, or dependency credentials inside the web application.
const databaseUrl = new URL(z.url().parse(process.env.DATABASE_URL));
if (
  process.env.NODE_ENV !== 'development' ||
  !['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)
)
  throw new Error('Dashboard setup requires a local development database');
const organizationId = '60000000-0000-4000-8000-000000000001';
const subject = 'local-admin@example.test';
const token = `rh_${randomBytes(32).toString('base64url')}`;
const expiresAt = new Date(Date.now() + 86400000).toISOString();
const pool = createDatabase(databaseUrl.href).pool;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    "INSERT INTO organizations(id,name) VALUES($1,'ResolveHub local synthetic workspace') ON CONFLICT(id) DO NOTHING",
    [organizationId],
  );
  const organization = await client.query<{ name: string }>(
    'SELECT name FROM organizations WHERE id=$1 AND deleted_at IS NULL',
    [organizationId],
  );
  if (organization.rows[0]?.name !== 'ResolveHub local synthetic workspace')
    throw new Error('Reserved demo organization conflicts with existing data');
  await client.query(
    "INSERT INTO memberships(id,organization_id,subject,role) VALUES($1,$2,$3,'admin') ON CONFLICT(organization_id,subject) DO NOTHING",
    [randomUUID(), organizationId, subject],
  );
  const row = await client.query<{ id: string }>(
    "SELECT id FROM memberships WHERE organization_id=$1 AND subject=$2 AND role='admin' AND active AND deleted_at IS NULL FOR UPDATE",
    [organizationId, subject],
  );
  const membershipId = z.uuid().parse(row.rows[0]?.id);
  await client.query(
    'UPDATE api_credentials SET revoked_at=now() WHERE organization_id=$1 AND membership_id=$2 AND revoked_at IS NULL',
    [organizationId, membershipId],
  );
  await client.query(
    'INSERT INTO api_credentials(token_hash,organization_id,membership_id,expires_at) VALUES($1,$2,$3,$4)',
    [createHash('sha256').update(token).digest('hex'), organizationId, membershipId, expiresAt],
  );
  await client.query('COMMIT');
  const endpoint = new URL(z.url().parse(process.env.S3_ENDPOINT));
  if (!['localhost', '127.0.0.1'].includes(endpoint.hostname))
    throw new Error('Dashboard setup requires local storage');
  const storage = new S3Client({
    endpoint: endpoint.href,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: z
        .string()
        .min(1)
        .parse(process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER),
      secretAccessKey: z
        .string()
        .min(1)
        .parse(process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD),
    },
  });
  try {
    const bucket = process.env.S3_BUCKET ?? 'resolvehub';
    try {
      await storage.send(new HeadBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        z.object({ httpStatusCode: z.literal(404) }).safeParse(error.$metadata).success
      )
        await storage.send(new CreateBucketCommand({ Bucket: bucket }), {
          abortSignal: AbortSignal.timeout(3000),
        });
      else throw error;
    }
  } finally {
    storage.destroy();
  }
  const path = '.env';
  let env = await readFile(path, 'utf8');
  for (const [key, value] of Object.entries({
    DASHBOARD_LOCAL_DEMO: 'true',
    DASHBOARD_LOCAL_DEMO_TOKEN: token,
  })) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    env = line.test(env)
      ? env.replace(line, `${key}=${value}`)
      : `${env.trimEnd()}\n${key}=${value}\n`;
  }
  await writeFile(path, env, { mode: 0o600 });
  await chmod(path, 0o600);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/local-workspace-access.json',
    JSON.stringify({ organizationId, subject, accessKey: token, expiresAt }, null, 2) + '\n',
    { mode: 0o600 },
  );
  await chmod('test-results/local-workspace-access.json', 0o600);
  console.info(
    'Local synthetic workspace prepared. Private expiring access details: test-results/local-workspace-access.json. Restart pnpm dev, then choose Open local workspace on /sign-in.',
  );
} catch {
  await client.query('ROLLBACK');
  throw new Error(
    'Local dashboard setup failed. Check database, storage and reserved membership configuration.',
  );
} finally {
  client.release();
  await pool.end();
}
