import { createHash } from 'node:crypto';
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const checksums: Record<string, string> = {
  darwin_arm64: 'b2417a3038edc5fe81dc178a889237724b595c5c9cfed875822008e46e862c7d',
  darwin_x64: 'c83bb16f54f0676afa4ea235fd757f3892d307dbd1bd201450de83af31986654',
  linux_x64: '39c3117b6af817592dcd0ce4242105c0a7af10948c2a425306f0be8f7a8a8ab1',
  linux_arm64: '5ca3433e8201da72a284aaa241a1bb5fb47f4abb4e384d39410ddd8062f49b90',
};
export async function downloadK6(directory: string) {
  const expected = checksums[`${process.platform}_${process.arch}`];
  if (!expected) throw new Error('Use Linux/macOS amd64 or arm64 for the pinned k6 runner');
  const platform = process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const base = `k6-v2.3.0-${platform}-${arch}`;
  const filename = `${base}.${platform === 'macos' ? 'zip' : 'tar.gz'}`;
  const response = await fetch(
    `https://github.com/grafana/k6/releases/download/v2.3.0/${filename}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok) throw new Error('Cannot download pinned k6 release');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('k6 checksum mismatch');
  const path = join(directory, filename);
  await writeFile(path, bytes);
  if (platform === 'macos') execFileSync('unzip', ['-q', path, '-d', directory]);
  else execFileSync('tar', ['-xzf', path, '-C', directory]);
  const binary = join(directory, base, 'k6');
  await chmod(binary, 0o700);
  return binary;
}
