import { evaluateAudit } from '../../scripts/security-scan.js';

const advisory = {
  github_advisory_id: 'GHSA-vfj7-8cjw-p6xm',
  module_name: 'braces',
  severity: 'high',
  patched_versions: null,
  findings: [{ dev: true, paths: ['packages__generated>@graphql-codegen/cli>micromatch>braces'] }],
};
const report = (entry: unknown = advisory) => ({
  advisories: { '123': entry },
  metadata: { vulnerabilities: { high: 1 } },
});
test('known unpatched dev-only codegen finding stays visible until the fixed expiry', () => {
  expect(evaluateAudit(report(), new Date('2026-10-21'))).toMatchObject({
    blocked: [],
    exceptions: [advisory.github_advisory_id],
  });
  expect(evaluateAudit(report(), new Date('2026-11-21')).blocked).toEqual([
    advisory.github_advisory_id,
  ]);
});
test.each([
  { findings: [{ dev: false, paths: ['packages__generated>@graphql-codegen/cli>braces'] }] },
  { findings: [{ dev: true, paths: ['services__api>braces'] }] },
  { github_advisory_id: 'GHSA-new-advisory' },
  { severity: 'critical' },
  { patched_versions: '>=3.0.4' },
])('production exposure, new advisories and available fixes always block: %j', (override) => {
  expect(
    evaluateAudit(report({ ...advisory, ...override }), new Date('2026-10-21')).blocked,
  ).toHaveLength(1);
});
test('unavailable or malformed registry responses fail closed', () => {
  expect(() => evaluateAudit({ error: 'Unavailable' })).toThrow();
  expect(() => evaluateAudit({})).toThrow();
});
