# Automated verification

Use Node/pnpm versions in `.nvmrc` and `package.json`, then `pnpm install --frozen-lockfile`.

| Command                                                  | Requirements and result                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:unit` / `make test`             | Jest unit and canonical contract checks; no running services or Docker                                                                                                       |
| `pnpm test:integration` / `make integration`             | Docker daemon; builds API/worker dependencies, creates PostgreSQL/Redis/MinIO Testcontainers, migrates, runs real Nest HTTP/GraphQL and persistence/worker tests, tears down |
| `pnpm test:coverage` / `pnpm test:all` / `make coverage` | Same isolated infrastructure, combined unit/contract/integration suites, a 95% actual-total branch gate and independent 80% critical-area gates                              |
| `pnpm typecheck` / `make typecheck`                      | Strict types for workspaces, tests and scripts                                                                                                                               |
| `pnpm check`                                             | Formatting, lint, types, contract compatibility and unit/contract tests                                                                                                      |
| `pnpm contracts:drift`                                   | Regenerates clients and rejects tracked/untracked/deleted generated drift                                                                                                    |

The first integration run needs registry access for pinned PostgreSQL and Redis images and may build MinIO from its pinned upstream source. Subsequent runs reuse image/build caches. A developer application stack can stay running; tests use separate infrastructure and random ports. The runner ignores `.env`, does not inherit provider credentials, forces `AI_PROVIDER=mock`, and uses deterministic synthetic embeddings. The Faker corpus fixes its seed and reference date; UUIDs used to isolate test schemas, credentials, jobs and buckets do not affect expected content or results.

Target a suite during development with `pnpm test:integration --testPathPatterns=ingestion` or `pnpm test --testPathPatterns=authorization`. Use the complete `test:coverage` command for the coverage gate; filtering suites will intentionally leave required branches uncovered. Tests are serialized to make failure injection and migration ownership predictable.

Reports are generated under ignored `coverage/`: `index.html`, `lcov.info`, `coverage-final.json` and `coverage-summary.json`. Structured Jest results and the separate worker's safe logs are under `test-results/`. CI always uploads these reports when present and fails on test, coverage or generated-client drift errors. Remote Actions execution still requires pushing the commit.

Coverage is measured over critical auth/application, ingestion, persistence and AI modules, with at least 95% branches required across the actual total and 80% independently for each area. `scripts/check-coverage.mjs` reads actual counts from the summary after Jest succeeds; it avoids Jest’s subtraction of directory-specific threshold groups from its global group. These percentages do not describe the entire monorepo. PDF worker-thread execution is behavior-tested but is outside Jest's process instrumentation; the included entrypoint's zero coverage is retained in the report. UI/browser checks remain a separate `pnpm test:e2e` command against the running web application.

The failure matrix includes invalid/stale/future webhook signatures, tenant forgery and credential revocation; idempotency conflicts/concurrent duplicates; invalid files; provider 429/500, hung calls and invalid vectors; Redis unavailability during dispatch and limiting; interrupted worker claims; partial embedding writes and publication/audit rollback; exhausted-job persistence and authorized idempotent replay. Reindex failures assert that the previously published version remains active and searchable.

Normal completion, errors and SIGINT/SIGTERM close applications, worker connections and owned containers. If the process was killed with SIGKILL or Docker failed during cleanup, inspect `docker ps -a` and remove only the disposable verification containers you identify by their random published ports and creation time. Never remove Compose volumes or another developer's containers as test recovery.

Milestone 06 adds the fixed 60-case AI evaluation, negative controls for the evaluators, and ten concurrent HTTP draft jobs to `pnpm test:coverage`. The drafting worker has its own 80% branch gate. See [AI operations](ai-drafting.md) for provider modes and benchmark denominators.

The [Milestone 12 audit](../verification/milestone-12-coverage-audit.md) inventories every original uncovered branch and every remaining gap by file, risk and testability. Runtime code and the coverage selection were not changed to raise the percentage.
