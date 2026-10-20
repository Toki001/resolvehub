# Milestone 04 verification

Verified locally on 2026-10-21 (Asia/Manila), using Node 22.22.3, pnpm 12.10.1, BullMQ 5.81.5, PostgreSQL 17/pgvector, Redis 7.4 and MinIO. PDF.js 6.4.299 and AWS SDK S3 3.1152.0 are locked. Redis failure tests use Testcontainers 12.2.1 with the same pinned Redis image as Compose. Remote GitHub Actions has not been run.

## Delivered

The separate worker now processes accepted document ingestions through actual MinIO download, MIME/streamed-size/SHA-256 validation, bounded UTF-8/Markdown/PDF extraction, stable chunking, rate-limited deterministic embeddings and versioned index publication. It rechecks live tenant/membership/resource state from PostgreSQL before processing. A session lock prevents duplicate execution for the same document/version. Extraction and embedding checkpoints survive retry and authorized replay. Final publication, version transitions, attempt success, job success and audit commit atomically.

Migration 0007 adds requester identity, durable dispatch scheduling, `ingestion_artifacts`, `job_attempts` and `failed_jobs`, tenant policies/indexes and restricted dispatch/admission functions. Previous SQL migrations are unchanged. Accepted handoffs survive Redis failures; four processing attempts remain authoritative in PostgreSQL even if Redis delivery state disappears. Permanent file/authority/state errors terminate immediately. Transient retries use exponential jitter, preserve the prior active index and write durable dead letters on exhaustion.

The API adds `POST /v1/documents/{id}/versions` and `GET /v1/jobs/{id}/failure`; existing authenticated admin replay now supports durable ingestion failures. Admission serializes at 1,000 unfinished document runs and returns 429/Retry-After. The revision contract accepts upload metadata without a title; title belongs to new-document creation. REST output was regenerated with openapi-typescript/openapi-fetch. GraphQL documents/SDL remain compatible.

## Executed commands and results

| Check                                                            | Result                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                 | Eight workspace projects reproduced successfully                                                             |
| `pnpm audit --prod --audit-level high`                           | No known production vulnerabilities reported                                                                 |
| `pnpm check`                                                     | Format, ESLint, strict types, canonical contracts/controller inventory and **33 unit/contract tests passed** |
| `pnpm build`                                                     | All seven package/service production builds passed                                                           |
| `pnpm contracts:drift`                                           | Regeneration exactly matched the intentionally staged REST output and unchanged GraphQL output               |
| `pnpm db:migrate`, then reapply                                  | 0007 applied; final reapply reported already current                                                         |
| Compiled `pnpm start` on isolated 3100/3101/3102; readiness wait | Web, API and worker ready with PostgreSQL/Redis/MinIO and dispatch checks                                    |
| `pnpm test:integration` against final compiled stack             | **54 tests passed**, six suites                                                                              |
| `pnpm test:e2e` against final compiled stack                     | **Six desktop/mobile browser tests passed**                                                                  |
| `pnpm smoke` against final compiled stack                        | All services healthy; real standalone BullMQ probe and duplicate identity check passed                       |
| `git diff --check`                                               | No whitespace errors                                                                                         |

**93 unique automated tests passed.** Repeated runs are not additional tests. No performance, recall, semantic quality, coverage-percentage or live-provider benchmark is claimed.

The new document failure suite includes 17 cases and uses real MinIO objects, an isolated Redis container and disposable PostgreSQL schemas. It verifies concurrent duplicate BullMQ deliveries produce one attempt/publication/audit; provider timeouts exhaust exactly four attempts into durable history; transient replay reuses extraction without another download; invalid hash/type/UTF-8/PDF fails once; a trigger-injected mid-batch write failure rolls embeddings back; a final audit failure rolls publication and job completion back; Redis producer disconnection and server restart retain the durable handoff; Redis loss during embedding admission resumes staged work; interrupted claims retain their budget and the fifth execution is prevented; provider rate limiting spans connections and respects cancellation; actual PDFs extract using both compiled and development worker entry points; admission admits one of two racing requests when 999 slots are occupied; a non-owner worker login processes work under the real grant script; and revoked membership prevents any content fetch.

The new HTTP suite proves an authenticated request traverses the real compiled worker from MinIO to searchable published knowledge, a failed replacement leaves the old pointer/search result intact, another successful revision replaces it, foreign tenants cannot append versions or inspect/replay failures, non-admin replay is denied, administrator replay is idempotent/audited and completes, and 1,000 pending fixture runs yield correlated 429 with Retry-After while an existing idempotency receipt still replays.

Existing migration, schema/policy parity, fixture repeatability, database tenant isolation, ticket/review/webhook contracts, cursor bounds and browser regressions remain passing. The API non-owner role is additionally denied execution of worker dispatch. Test containers, objects, schemas and temporary roles are scoped to the suite and cleaned up; the main bucket is retained if the HTTP suite created it. The Redis helper container uses explicit teardown with Ryuk disabled, so tests do not require an additional helper image.

## Corrections found during implementation

Strict compilation caught the removed PDF.js `isEvalSupported` option in version 6 and an untyped evolving chunk array; implementation was aligned with the installed API and typed chunk records. The first Redis restart test reused Docker's previous mapped port and left retrying test clients; the harness now refreshes the port, closes disconnected clients and starts recovery against the restarted endpoint. The corrected suite exits normally. Optional native build scripts for test tooling (`cpu-features`, `ssh2`, `protobufjs`) were explicitly disabled in pnpm's build allowlist; frozen installation and container tests passed with those settings.

Final review also separated document-creation metadata from revision metadata, made worker pool capacity match configured concurrency plus dispatch/health needs, handled checked-out database connection errors safely and verified the development PDF entry point. API and worker environment errors identify embedding configuration fields without reflecting their values. All affected checks passed after these corrections.

## Scope and operational limits

The embedding implementation is **resolvehub-synthetic-sha256-v1, 64 dimensions**. It generates deterministic numeric vectors and verifies mechanics/isolation; it provides no live semantic retrieval or generation claim. PDF extraction has no OCR. The worker does not process draft-generation or webhook domain jobs, and approval never sends messages. Dashboard data/upload/operations wiring, live-provider quality, metrics/tracing, scale benchmarking and release deployment remain later work.

Admission counts accepted, delayed and processing work together, so its maximum unfinished backlog is conservatively 1,000 even during Redis outage. Processing is at-least-once; stable identities, version locks, checkpoints and transactions provide idempotent effects. No exactly-once guarantee is made. PostgreSQL durable attempts, not Redis failure events, govern the retry budget. Database failures before a claim do not consume a processing attempt; infrastructure recovery can redeliver after the database returns.

Compose's owner credential remains local administration convenience. API and worker deployments must use the separate non-owner grants and scoped storage credentials described in [ingestion recovery](../operations/ingestion-recovery.md). Domain access remains tied to verified application identity; RLS defends against missing predicates, not a compromised application credential deliberately choosing another session context.

The [recovery runbook](../operations/ingestion-recovery.md) covers stage limits, readiness, Redis/MinIO/PostgreSQL outages, worker interruption, partial writes, capacity saturation and authenticated manual replay. Historical failed synthetic fixtures are not fabricated into live attempt histories. No real customer records were imported. The isolated verification processes were stopped after checks; the pre-existing development stack and Compose data volumes were preserved. Restart an existing development process to reload built shared exports after migrating.
