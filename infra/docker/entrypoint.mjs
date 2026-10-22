import { readFile } from 'node:fs/promises';

// Explicit allowlist: Docker/Kubernetes secret mounts never become build args.
const secretFields = [
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
  'REDIS_URL',
  'API_SECRET_KEY',
  'GEMINI_API_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
];
for (const field of secretFields) {
  const path = process.env[`${field}_FILE`];
  if (!path) continue;
  if (process.env[field]) throw new Error(`Configure either ${field} or ${field}_FILE`);
  try {
    const value = (await readFile(path, 'utf8')).trimEnd();
    if (!value) throw new Error('Empty secret');
    process.env[field] = value;
  } catch {
    throw new Error(`Cannot load secret: ${field}_FILE`);
  }
  delete process.env[`${field}_FILE`];
}
