import { execFileSync } from 'node:child_process';

execFileSync('git', ['diff', '--exit-code', '--', 'packages/generated/src'], { stdio: 'inherit' });
const extra = execFileSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '--', 'packages/generated/src'],
  { encoding: 'utf8' },
).trim();
if (extra) {
  console.error(`Untracked generated files must be committed:\n${extra}`);
  process.exit(1);
}
console.info('Generated REST client and GraphQL documents match their contracts.');
