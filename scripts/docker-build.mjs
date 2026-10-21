import { execFileSync } from 'node:child_process';

for (const target of ['api', 'worker', 'web']) {
  execFileSync(
    'docker',
    [
      'build',
      '--file',
      'infra/docker/Dockerfile',
      '--target',
      target,
      '--tag',
      `resolvehub-ci/${target}:milestone07`,
      '.',
    ],
    { stdio: 'inherit' },
  );
}
