import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const reportSchema = z.object({
  advisories: z.record(
    z.string(),
    z.object({
      github_advisory_id: z.string(),
      module_name: z.string(),
      severity: z.string(),
      patched_versions: z.string().nullable(),
      findings: z.array(z.object({ dev: z.boolean(), paths: z.array(z.string()).min(1) })).min(1),
    }),
  ),
  metadata: z.object({ vulnerabilities: z.record(z.string(), z.number()) }),
});

export function evaluateAudit(input: unknown, now = new Date()) {
  const report = reportSchema.parse(input);
  const blocked: string[] = [],
    exceptions: string[] = [];
  for (const finding of Object.values(report.advisories)) {
    if (!['high', 'critical'].includes(finding.severity)) continue;
    // No released fix as of 2026-10-21. Only repository-controlled codegen globs
    // reach this dev tool. It is absent from every production dependency closure.
    const exception =
      finding.github_advisory_id === 'GHSA-vfj7-8cjw-p6xm' &&
      finding.module_name === 'braces' &&
      finding.severity === 'high' &&
      finding.patched_versions === null &&
      now < new Date('2026-11-21T00:00:00Z') &&
      finding.findings.every(
        (entry) =>
          entry.dev &&
          entry.paths.every((path) => path.startsWith('packages__generated>@graphql-codegen/cli>')),
      );
    (exception ? exceptions : blocked).push(finding.github_advisory_id);
  }
  return { blocked, exceptions, vulnerabilities: report.metadata.vulnerabilities };
}

async function main() {
  const result = spawnSync('pnpm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null || result.status > 1)
    throw new Error('Dependency audit could not complete');
  const input: unknown = JSON.parse(result.stdout);
  const evaluation = evaluateAudit(input);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/dependency-audit.json',
    `${JSON.stringify({ report: input, evaluation }, null, 2)}\n`,
  );
  console.info(JSON.stringify(evaluation, null, 2));
  if (evaluation.exceptions.length)
    console.warn(
      'Unpatched development-only advisory exception expires 2026-11-21; see docs/operations/releases.md.',
    );
  if (evaluation.blocked.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Dependency audit failed; security gate is closed.');
    process.exitCode = 1;
  });
