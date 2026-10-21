import { writeFile, appendFile, readdir } from 'node:fs/promises';

const {
  COMPONENT,
  IMAGE,
  TAG,
  DIGEST,
  GITHUB_SHA,
  GITHUB_SERVER_URL,
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
} = process.env;
if (!['web', 'api', 'worker'].includes(COMPONENT) || !/^sha256:[a-f0-9]{64}$/.test(DIGEST ?? ''))
  throw new Error('Missing valid component digest');
const manifest = {
  component: COMPONENT,
  image: `${IMAGE}@${DIGEST}`,
  tag: `${IMAGE}:${TAG}`,
  revision: GITHUB_SHA,
  verificationRun: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
  migrations: (await readdir('packages/db/migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort(),
};
await writeFile('release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${COMPONENT}\n\n\`${manifest.image}\`\n\nPromote only after all three components publish successfully.\n`,
  );
