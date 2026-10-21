import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

for (const name of await readdir('.github/workflows')) {
  if (!/\.ya?ml$/.test(name)) continue;
  const document = parse(await readFile(`.github/workflows/${name}`, 'utf8'));
  for (const job of Object.values(document.jobs)) {
    for (const use of [job.uses, ...(job.steps ?? []).map((step) => step.uses)]) {
      if (use === undefined) continue;
      if (
        typeof use !== 'string' ||
        (!use.startsWith('./') && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(use))
      )
        throw new Error(`Unpinned external action in ${name}`);
    }
  }
}

const version = '1.7.12';
const checksums = {
  linux_x64: '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
  linux_arm64: '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
  darwin_x64: '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
  darwin_arm64: 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
};
const expected = checksums[`${process.platform}_${process.arch}`];
if (!expected) throw new Error('Unsupported actionlint platform; use Linux amd64/arm64 or macOS');
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const archive = `actionlint_${version}_${process.platform}_${arch}.tar.gz`;
const directory = await mkdtemp(join(tmpdir(), 'resolvehub-actionlint-'));
try {
  const response = await fetch(
    `https://github.com/rhysd/actionlint/releases/download/v${version}/${archive}`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) throw new Error('Cannot download pinned actionlint release');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('actionlint archive checksum mismatch');
  const path = join(directory, archive);
  await writeFile(path, bytes);
  execFileSync('tar', ['-xzf', path, '-C', directory, 'actionlint']);
  execFileSync(join(directory, 'actionlint'), ['-color'], { stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
