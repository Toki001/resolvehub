import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { isAbsolute } from 'node:path';

if (!process.argv[2]) throw new Error('Pass the absolute path to a deployment env file');
const env = parseEnv(await readFile(process.argv[2], 'utf8'));
for (const component of ['WEB', 'API', 'WORKER']) {
  const field = `${component}_IMAGE`;
  const value = env[field] ?? '';
  if (
    !new RegExp(
      `^ghcr\\.io/[a-z0-9_.-]+/[a-z0-9_.-]+/${component.toLowerCase()}@sha256:[a-f0-9]{64}$`,
    ).test(value) ||
    value.endsWith('0'.repeat(64))
  )
    throw new Error(`Invalid immutable image reference: ${field}`);
}
for (const field of ['WEB_ORIGIN', 'S3_ENDPOINT']) {
  const url = new URL(env[field] ?? '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (field === 'WEB_ORIGIN' && url.origin !== env[field])
  )
    throw new Error(`Invalid HTTPS deployment field: ${field}`);
}
if (!env.RESOLVEHUB_SECRETS_DIR || !isAbsolute(env.RESOLVEHUB_SECRETS_DIR))
  throw new Error('RESOLVEHUB_SECRETS_DIR must be absolute');
console.info('Deployment references, HTTPS endpoints and secret directory validated.');
