import { releasePlan } from '../../scripts/release-plan.js';

const trusted = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: 'Example/ResolveHub',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REF_PROTECTED: 'true',
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '1',
};
test('release references are unique per attempt and normalize GHCR repository names', () => {
  const first = releasePlan(trusted, true, true);
  expect(first.prefix).toBe('ghcr.io/example/resolvehub');
  expect(first.imageTag).toContain(`sha-${trusted.GITHUB_SHA}`);
  expect(releasePlan({ ...trusted, GITHUB_RUN_ATTEMPT: '2' }, true, true).imageTag).not.toBe(
    first.imageTag,
  );
  expect(
    releasePlan(
      { ...trusted, GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_REF_PROTECTED: 'false' },
      true,
      true,
    ).version,
  ).toBe('v1.2.3');
});
test.each([
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_EVENT_NAME: 'pull_request_target' },
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REF: 'refs/tags/v1.2.3;echo exploit' },
  { GITHUB_REF: 'refs/tags/v01.2.3' },
  { GITHUB_REF_PROTECTED: 'false' },
  { GITHUB_SHA: 'HEAD' },
  { GITHUB_RUN_ID: '../path' },
  { GITHUB_REPOSITORY: 'owner/repo\ninjection' },
])('rejects untrusted or malformed release metadata: %j', (override) => {
  expect(() => releasePlan({ ...trusted, ...override }, true, true)).toThrow();
});
test('unprotected main and commits outside main cannot publish even with a valid version tag', () => {
  expect(() => releasePlan(trusted, false, true)).toThrow();
  expect(() => releasePlan({ ...trusted, GITHUB_REF: 'refs/tags/v1.2.3' }, true, false)).toThrow();
});
