import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('secret mounts load before application startup and errors never disclose secret values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resolvehub-secret-test-'));
  const secret = 'synthetic-secret-value';
  const path = join(directory, 'api-key');
  try {
    await writeFile(path, `${secret}\n`);
    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          resolve('infra/docker/entrypoint.mjs'),
          '-e',
          "if(process.env.API_SECRET_KEY !== 'synthetic-secret-value')process.exit(2)",
        ],
        { env, encoding: 'utf8' },
      );
    expect(run({ API_SECRET_KEY_FILE: path }).status).toBe(0);
    const conflict = run({ API_SECRET_KEY_FILE: path, API_SECRET_KEY: secret });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).not.toContain(secret);
    expect(conflict.stderr).toContain('either API_SECRET_KEY or API_SECRET_KEY_FILE');
    const missing = run({ API_SECRET_KEY_FILE: join(directory, secret) });
    expect(missing.status).toBe(1);
    expect(missing.stderr).not.toContain(secret);
    await writeFile(path, '\n');
    expect(run({ API_SECRET_KEY_FILE: path }).status).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment promotion rejects mutable tags, placeholder digests and insecure origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resolvehub-deployment-test-'));
  const path = join(directory, 'release.env');
  const env = {
    WEB_IMAGE: `ghcr.io/example/resolvehub/web@sha256:${'a'.repeat(64)}`,
    API_IMAGE: `ghcr.io/example/resolvehub/api@sha256:${'b'.repeat(64)}`,
    WORKER_IMAGE: `ghcr.io/example/resolvehub/worker@sha256:${'c'.repeat(64)}`,
    WEB_ORIGIN: 'https://support.example.test',
    S3_ENDPOINT: 'https://minio.example.test',
    RESOLVEHUB_SECRETS_DIR: '/etc/resolvehub/secrets',
  };
  async function check(override: Record<string, string>) {
    await writeFile(
      path,
      Object.entries({ ...env, ...override })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    return spawnSync(process.execPath, ['scripts/check-deployment.mjs', path], { encoding: 'utf8' })
      .status;
  }
  try {
    expect(await check({})).toBe(0);
    expect(await check({ API_IMAGE: 'ghcr.io/example/resolvehub/api:latest' })).toBe(1);
    expect(
      await check({ WEB_IMAGE: `ghcr.io/example/resolvehub/web@sha256:${'0'.repeat(64)}` }),
    ).toBe(1);
    expect(await check({ WEB_ORIGIN: 'http://support.example.test' })).toBe(1);
    expect(await check({ S3_ENDPOINT: 'https://secret@example.test' })).toBe(1);
    expect(await check({ RESOLVEHUB_SECRETS_DIR: './secrets' })).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
