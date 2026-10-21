import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const inputSchema = z.object({
  GITHUB_EVENT_NAME: z.literal('push'),
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  GITHUB_SHA: z.string().regex(/^[a-f0-9]{40}$/),
  GITHUB_REF: z.string(),
  GITHUB_REF_PROTECTED: z.enum(['true', 'false']),
  GITHUB_RUN_ID: z.string().regex(/^[1-9]\d*$/),
  GITHUB_RUN_ATTEMPT: z.string().regex(/^[1-9]\d*$/),
});
const versionRef = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releasePlan(input: NodeJS.ProcessEnv, mainProtected: boolean, ancestor: boolean) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid release event metadata');
  const env = parsed.data;
  const main = env.GITHUB_REF === 'refs/heads/main';
  if (!main && !versionRef.test(env.GITHUB_REF)) throw new Error('Release ref is not supported');
  if (!mainProtected || !ancestor || (main && env.GITHUB_REF_PROTECTED !== 'true'))
    throw new Error('Release commit must belong to protected main');
  const version = main ? 'main' : env.GITHUB_REF.slice('refs/tags/'.length);
  // Every rerun receives a new tag. No mutable latest/main/semver aliases.
  const imageTag = `${version}-sha-${env.GITHUB_SHA}-run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  if (imageTag.length > 128) throw new Error('Release tag exceeds registry limits');
  return { prefix: `ghcr.io/${env.GITHUB_REPOSITORY.toLowerCase()}`, imageTag, version };
}

async function main() {
  const repository = inputSchema.parse(process.env).GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!token || !process.env.GITHUB_OUTPUT)
    throw new Error('Release authentication/output missing');
  const response = await fetch(`https://api.github.com/repos/${repository}/branches/main`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Cannot verify protected main');
  const branch = z.object({ protected: z.boolean() }).parse(await response.json());
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== process.env.GITHUB_SHA) throw new Error('Checkout does not match release commit');
  // checkout fetch-depth: 0 supplies origin/main, including for tag events.
  execFileSync('git', ['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main']);
  const plan = releasePlan(process.env, branch.protected, true);
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `prefix=${plan.prefix}\ntag=${plan.imageTag}\nversion=${plan.version}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Release authorization failed; publication is blocked.');
    process.exitCode = 1;
  });
}
