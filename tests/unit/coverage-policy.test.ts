import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/check-coverage.mjs');
test('overall coverage gate uses actual counts, rejects rounded-up results and fails closed on invalid reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'resolvehub-coverage-policy-'));
  const path = join(directory, 'summary.json');
  try {
    for (const branches of [
      undefined,
      { total: 0, covered: 0 },
      { total: 10, covered: 11 },
      { total: 10000, covered: 9499, pct: 95 },
    ]) {
      await writeFile(path, JSON.stringify({ total: { branches } }));
      expect(() => execFileSync(process.execPath, [script, path], { stdio: 'pipe' })).toThrow();
    }
    await writeFile(
      path,
      JSON.stringify({ total: { branches: { total: 100, covered: 95, pct: 0 } } }),
    );
    expect(execFileSync(process.execPath, [script, path], { encoding: 'utf8' })).toContain(
      '95% gate passed',
    );
    expect(() =>
      execFileSync(process.execPath, [script, join(directory, 'missing.json')], { stdio: 'pipe' }),
    ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
