# Milestone 05 verification

Verified locally on 2026-10-21 with Node 22.22.3, pnpm 12.10.1 and Docker Desktop. This records local results; GitHub Actions has not been run remotely.

The combined Jest run passed **180 tests in 20 suites**: 113 unit/contract checks and 67 integration checks. Playwright passed **6 desktop/mobile browser checks** separately. No real customer records or paid LLM calls were used.

| Critical area                        | Covered / total branches | Measured coverage | Required |
| ------------------------------------ | ------------------------ | ----------------- | -------- |
| API authorization                    | 50 / 54                  | 92.59%            | 80%      |
| API application services             | 132 / 138                | 95.65%            | 80%      |
| Worker ingestion                     | 176 / 190                | 92.63%            | 80%      |
| Scoped persistence and ticket policy | 199 / 222                | 89.64%            | 80%      |
| AI adapters                          | 15 / 15                  | 100.00%           | 80%      |
| Combined critical modules            | 572 / 619                | **92.40%**        | 80%      |

Covered statements/lines: 2,431 / 2,484 (97.86%). Covered functions: 148 / 152 (97.36%). Counts come from `coverage/coverage-summary.json`; percentages in the table are rounded to two decimals. Jest's console truncates some percentages. Reports include HTML, LCOV, JSON coverage and structured Jest results; generated artifacts remain ignored and CI uploads them.

Commands actually run:

| Command                                           | Result                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                  | Pass; all eight workspace projects; lockfile unchanged                                                                                                         |
| `pnpm check`                                      | Pass: formatting, ESLint, strict workspace/test/script types, OpenAPI 3.1 and 13 controller operations, GraphQL SDL/client operations, 113 unit/contract tests |
| `pnpm typecheck`                                  | Pass separately, including the new runner, Nest helpers and test fixtures                                                                                      |
| `pnpm contracts:drift`                            | Pass; regenerated REST and GraphQL clients match committed output                                                                                              |
| `pnpm build`                                      | Pass; all seven packages/applications, including Next.js production output                                                                                     |
| `pnpm test:integration --testPathPatterns=health` | Pass; isolated real Nest API, PostgreSQL/pgvector, Redis and MinIO                                                                                             |
| `pnpm test:coverage`                              | Pass; 180 tests, five independent critical-area branch gates                                                                                                   |
| `pnpm test:e2e`                                   | Pass; six desktop/mobile Chrome checks against the existing local dashboard                                                                                    |
| `pnpm smoke`                                      | Pass; web/API/worker readiness and separate-worker BullMQ probe with duplicate job ID                                                                          |
| `pnpm audit --prod --audit-level high`            | Pass; no known vulnerabilities reported                                                                                                                        |
| `git diff --check`                                | Pass                                                                                                                                                           |

The coverage rejection was also exercised deliberately: `pnpm test --config tests/jest.coverage.config.cjs --testPathPatterns=ticket-status --coverageDirectory=/private/tmp/resolvehub-m05-gate-proof` passed its 17 selected tests but exited 1 because the configured 80% area thresholds were unmet. That expected failure used a separate report directory. Full-suite coverage subsequently passed.

New units exercise server-derived identity, malformed credentials, dependency failure, guard authentication reuse, role permissions, canonical citation UUID formatting, key length/character boundaries, stable payload hashes, all 16 ticket state/event combinations and repeated-command convergence. Existing cursor and chunking units remain in the gate. Ticket creation uses the tested state policy; an external ticket status API and human-readable citation renderer are not introduced in this testing milestone.

Integration uses disposable PostgreSQL/pgvector, Redis and MinIO Testcontainers plus the real Nest testing module and a separate compiled worker. Existing deterministic Faker fixtures verify repeatability. Coverage includes signed invalid/stale/future webhooks, actual OpenAPI/GraphQL responses, cross-tenant denial, ingestion and duplicates, timeout retries, durable DLQ/manual replay, capacity and request correlation. New failure injection adds typed provider 429/500 status errors with bounded Retry-After, 500 exhaustion retaining the searchable old version, invalid embedding count/dimension/non-finite/zero vectors, corrupted authoritative payloads, checkpoint conflicts, incomplete-index rollback, and authority revocation/deletion between embedding and publication. The existing Redis disconnect/restart, partial-vector transaction, interrupted claim and publication-audit rollback tests remain passing.

Initial runs found a wrong synthetic model identifier in the new fixture configuration, missing explicit ESM test types, a logger test option rejected by strict types, and an API readiness race before Redis connected. These were corrected. One sandboxed `pnpm check` failed because tsx could not create its local IPC socket; the same check passed with the required local execution permission. The initial coverage run measured 84.55% overall and 76.97% for worker branches; added storage, runtime and failure cases raised every critical area above 80%. Key boundary testing also closed JavaScript's end-anchor loophole for a trailing newline. Browser output now has its own subdirectory so Playwright cleanup cannot delete Jest results or worker logs.

The included PDF thread entrypoint reports zero in Jest because execution happens in another thread. It remains in the worker coverage denominator; both compiled and development PDF extraction paths have real behavior tests. Provider status failures are injected at the typed embedding boundary, not through a live paid provider. Semantic retrieval quality, grounded draft generation and outbound sending remain outside this milestone.

Container inspection after verification showed only the developer's three Compose services; disposable test containers had been stopped. Existing application processes and Compose volumes were preserved. See [verification operations](../operations/verification.md) and [decision 0006](../architecture/decisions/0006-isolated-verification.md) for commands, coverage scope and teardown limits.
