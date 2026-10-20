import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createDatabase } from '@resolvehub/db';
import { z } from 'zod';
import { createToken, tokenDigest, seal } from '../services/api/src/auth/crypto.js';

// Offline provisioning only. Database administration access is required; this
// command is never exposed through an unauthenticated HTTP registration route.
const { values } = parseArgs({
  options: {
    organization: { type: 'string' },
    'organization-id': { type: 'string' },
    subject: { type: 'string' },
    role: { type: 'string', default: 'admin' },
    webhook: { type: 'boolean', default: false },
  },
});
const subject = z.email().parse(values.subject);
const role = z.enum(['admin', 'agent', 'analyst']).parse(values.role);
const master = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .parse(process.env.API_SECRET_KEY);
const databaseUrl = z.url().parse(process.env.DATABASE_URL);
const { pool } = createDatabase(databaseUrl);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const organizationId = values['organization-id']
    ? z.uuid().parse(values['organization-id'])
    : randomUUID();
  if (values['organization-id']) {
    if (
      (await client.query('SELECT id FROM organizations WHERE id=$1', [organizationId]))
        .rowCount !== 1
    )
      throw new Error('Organization does not exist');
  } else
    await client.query('INSERT INTO organizations (id,name) VALUES ($1,$2)', [
      organizationId,
      z.string().min(1).max(200).parse(values.organization),
    ]);
  await client.query(
    'INSERT INTO memberships (id,organization_id,subject,role) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,subject) DO NOTHING',
    [randomUUID(), organizationId, subject, role],
  );
  const existing = await client.query<{ id: string; role: string; active: boolean }>(
    'SELECT id,role,active FROM memberships WHERE organization_id=$1 AND subject=$2 FOR UPDATE',
    [organizationId, subject],
  );
  const membership = existing.rows[0];
  if (!membership || !membership.active || membership.role !== role)
    throw new Error('Membership is inactive or has another role');
  const membershipId = z.uuid().parse(membership.id);
  await client.query(
    'UPDATE api_credentials SET revoked_at=now() WHERE organization_id=$1 AND membership_id=$2 AND revoked_at IS NULL',
    [organizationId, membershipId],
  );
  const token = createToken();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await client.query(
    'INSERT INTO api_credentials (token_hash,organization_id,membership_id,expires_at) VALUES ($1,$2,$3,$4)',
    [tokenDigest(token), organizationId, membershipId, expiresAt],
  );
  const credentials: Record<string, string> = { organizationId, membershipId, token, expiresAt };
  if (values.webhook) {
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    await client.query(
      'INSERT INTO webhook_integrations (id,organization_id,encrypted_secret) VALUES ($1,$2,$3)',
      [id, organizationId, seal(secret, master, `resolvehub:webhook:${id}`)],
    );
    credentials.webhookId = id;
    credentials.webhookSecret = secret;
  }
  await client.query('COMMIT');
  console.info('Credentials shown once. Store securely; never commit or log them.');
  console.info(JSON.stringify(credentials, null, 2));
} catch {
  await client.query('ROLLBACK');
  console.error('Provisioning failed. Check arguments, membership uniqueness and database access.');
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
