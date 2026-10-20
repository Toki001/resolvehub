import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';

let content;
let missing = false;
try {
  content = await readFile('.env', 'utf8');
} catch (error) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
    throw error;
  missing = true;
  content = await readFile('.env.example', 'utf8');
}
const matches = [...content.matchAll(/^[ \t]*(?:export[ \t]+)?API_SECRET_KEY[ \t]*=[ \t]*(.*)$/gm)];
const match = matches[0];
const raw = (match?.[1] ?? '').trim();
const quoted = raw.match(/^(['"])(.*?)\1[ \t]*(?:#.*)?$/);
const value = quoted?.[2] ?? raw.split('#')[0]?.trim() ?? '';
if (
  matches.length > 1 ||
  (value && value !== 'GENERATE_WITH_PNPM_ENV_SETUP' && !/^[a-f0-9]{64}$/.test(value))
) {
  console.error(
    'Invalid existing API_SECRET_KEY. Correct it explicitly; setup will not rotate secrets.',
  );
  process.exit(1);
}
if (!value || value === 'GENERATE_WITH_PNPM_ENV_SETUP') {
  const setting = `API_SECRET_KEY=${randomBytes(32).toString('hex')}`;
  content = match ? content.replace(match[0], setting) : `${content.trimEnd()}\n${setting}\n`;
  missing = true;
}
if (missing) await writeFile('.env', content, { mode: 0o600 });
await chmod('.env', 0o600);
console.info('Local .env ready; existing valid API secret preserved.');
