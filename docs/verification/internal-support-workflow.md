# Authenticated internal support workflow verification

Measured locally on 2026-10-21 with Node 22.22.3, pnpm 12.10.1 and Docker on macOS/arm64. This is the dashboard follow-up to milestones 01–08, implementing the user's internal-delivery choice. No remote release or deployment was performed.

## Implemented behavior

Verified membership access establishes an HttpOnly browser session. Server-side generated REST clients perform mutations; generated schema-first GraphQL documents read organization-scoped tickets, knowledge, reviews, jobs and paginated message history. The API remains the authorization boundary. The local development bootstrap provisions a reserved synthetic administrator without importing customer records or replacing existing organizations.

The workflow supports private source uploads and new document versions, persisted ingestion progress, ticket creation and status transitions, customer context, asynchronous cited drafting, draft edits with optimistic revisions and original wording, explicit approval/rejection and conversation history. Approval revalidates eligible evidence and atomically writes its review, one linked agent message with `delivery_status='internal'`, audit events and idempotency receipt. Rejection creates no reply. Existing approvals are not retroactively converted into messages.

`ReplyDelivery.stage` is an injected transaction boundary. Only the internal adapter is implemented. There is no SMTP sender, outbound webhook sender or externally delivered status.

## Commands and results

| Command                                                                                                  | Observed result                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                         | Passed for all nine workspace projects.                                                                                                                                                                                       |
| `pnpm dashboard:setup`                                                                                   | Applied migration 0012, provisioned the reserved local membership and private bucket, and wrote ignored mode-0600 access files.                                                                                               |
| `pnpm check`                                                                                             | Formatting, ESLint, strict workspace/test TypeScript, canonical contract/controller compatibility and 197 Jest unit/contract tests in 22 suites passed. Contract validation covers 17 REST operations.                        |
| `pnpm test:coverage`                                                                                     | 289 tests in 33 suites passed; aggregate branch coverage 93.19%. All independent critical-area 80% branch gates passed. Disposable PostgreSQL/pgvector, Redis and MinIO; no developer database or `.env`.                     |
| `pnpm test:integration --runTestsByPath tests/integration/persistence.test.ts`                           | 11 tests passed after the final fixture correction; seed repeatability and received/internal message classification verified in PostgreSQL.                                                                                   |
| `pnpm test:dashboard`                                                                                    | Production build and 12 desktop/mobile Chromium browser checks passed. The harness verified exactly two approved internal messages across both browser projects.                                                              |
| `pnpm docker:build`                                                                                      | Separate API, worker and web production images built locally on arm64.                                                                                                                                                        |
| `pnpm docker:smoke`                                                                                      | Clean/repeat image migration, runtime grants, non-root/read-only filesystems, secret mounts, health/readiness, REST/GraphQL, web assets, standalone-worker BullMQ roundtrip, duplicate probe ID and graceful shutdown passed. |
| `pnpm ci:workflows`                                                                                      | actionlint and reviewed-SHA policy validation passed, including the new isolated browser job and required-check aggregate.                                                                                                    |
| `pnpm security:scan`                                                                                     | Passed the existing policy with no blocked advisories. Existing development-only `GHSA-vfj7-8cjw-p6xm` exception expires 2026-11-21.                                                                                          |
| `pnpm audit --prod --json`                                                                               | Zero production dependency advisories reported.                                                                                                                                                                               |
| `docker compose --env-file infra/deploy/release.env.example -f infra/deploy/compose.yaml config --quiet` | Deployment example parsed successfully, including separate API/worker storage secret mounts. Placeholder image digests remain examples.                                                                                       |

`pnpm contracts:drift` regenerated the REST and GraphQL clients and passed with no unstaged generated differences. Final formatting and staged/unstaged whitespace checks also passed. The staged patch was checked against private runtime credentials; access files and test artifacts remain excluded.

Critical-area branch coverage from the combined run:

| Area                     | Branch coverage |
| ------------------------ | --------------: |
| API application services |          96.96% |
| API authentication       |          92.59% |
| Database repositories    |          89.14% |
| AI drafting              |          96.42% |
| Worker drafting          |          90.90% |
| Worker ingestion         |          93.06% |

## Integrity and browser evidence

New database/API integration checks cover stale edits, explicit acknowledgement of edited wording, immutable reviewed drafts, concurrent approvals, duplicate requests, rejection without a reply, cross-tenant non-disclosure, analyst write denial, stale/invalid ticket transitions, more than 100 messages with bounded opaque cursors and private uploads with hash/type/size/idempotency validation. An injected message-insert failure verifies rollback of review, message, audit and idempotency state before a successful retry with the same key.

Desktop and mobile browser checks exercise upload → published index → ticket → cited draft → edit → approval → internal conversation, plus rejection, customer context, resolve/reopen, keyboard navigation, service errors, read-only controls, session cookie properties, sign-out and tenant switching. The production-build harness owns temporary credentials, ports, processes and infrastructure. It asserts persisted replies rather than accepting UI success text alone.

Screenshots from the passing synthetic workflow: [desktop conversation](internal-support-desktop.png), [mobile conversation](internal-support-mobile.png).

A recovery regression also creates two drafts in succession, forces job polling to return 503 for the later request, verifies that the previous draft's success/link is absent, and resumes polling to discover the new result without resubmitting it. Progress state is reset for each job identifier.

The first browser run exposed a sign-out navigation race: cookie deletion removed the client form before its navigation effect. The final implementation redirects on the server after clearing the session. A later mobile check navigated away before the sign-out action completed; the test now waits for that redirect and asserts removal of the session cookie before navigating. Early checks also found a GraphQL operation missing newly required draft edit fields and overly strict browser label selectors for populated controls; the operation was regenerated and browser selectors now use accessible textbox/combobox roles. These failures were corrected before the passing runs.

The normal local development stack was also checked at `/sign-in`: **Open local workspace** authenticated the provisioned membership, Settings showed the verified administrator, and sign-out cleared the session. Private keys remain in ignored local files, never in this report or screenshots.

## Limits

- Generation and embeddings in automated checks use the deterministic synthetic providers. The review screen labels that provider. No paid model call or live-provider quality, latency or cost benchmark was performed. A live model endpoint/model configuration is still needed to replace local synthetic generation; no local Ollama service was found.
- The 93.19% figure covers the configured critical-service instrumentation set, not every React component. Browser behavior is checked separately.
- Local image verification covers arm64. The updated GitHub workflow has been validated locally but has not been run remotely during this work; remote releases, repository protection and registry permissions remain operator tasks.
- Migration 0012 is additive and has been applied locally. Keep it and its data during an image rollback. An older API cannot record internal replies on approval; restore the workflow-capable API before further approvals.
- No external delivery, identity-provider integration, membership-administration UI or automatic abandoned-upload cleanup was added. See [internal workflow operations](../operations/internal-support.md) for deployment and recovery details.
