import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('first-run setup creates a private key, preserves it, and refuses silent rotation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resolvehub-env-'));
  const script = resolve('scripts/setup-env.mjs');
  const run = () => spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  try {
    await writeFile(
      join(directory, '.env.example'),
      'NODE_ENV=test\nAPI_SECRET_KEY=GENERATE_WITH_PNPM_ENV_SETUP\n',
    );
    expect(run().status).toBe(0);
    const original = await readFile(join(directory, '.env'), 'utf8');
    expect(original).toMatch(/API_SECRET_KEY=[a-f0-9]{64}/);
    expect((await stat(join(directory, '.env'))).mode & 0o777).toBe(0o600);
    expect(run().status).toBe(0);
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(original);
    const invalid = 'API_SECRET_KEY=invalid-existing-value\n';
    await writeFile(join(directory, '.env'), invalid);
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).not.toContain('invalid-existing-value');
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(invalid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
