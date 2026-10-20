# Milestone 03 verification

Verified locally on 2026-10-20 with Node 22.22.3, pnpm 12.10.1, PostgreSQL 17/pgvector and the existing Compose infrastructure. This records local runs; remote GitHub Actions has not been run.

## Delivered

Typed Drizzle models and versioned forward SQL cover the requested organizations, memberships, customers, tickets/messages, knowledge documents/versions/chunks, drafts, normalized citations, audit events and idempotency records, plus existing credential/integration/job storage. Composite tenant references/indexes, unique revision/chunk positions, lifecycle timestamps, soft deletion, RLS and explicit runtime grants are present. Migrations 0001/0002 were preserved byte-for-byte.

Publication/deletion uses scoped Drizzle transactions, parent/version locks and atomic audit changes. Vector retrieval materializes authorized, live, indexed active-version candidates before exact pgvector cosine ranking. Lexical retrieval and review evidence checks independently exclude deleted/superseded versions. Existing contract writes remain supported by compatibility triggers; invalid historical citation references are invalidated rather than silently accepted.

Faker 9.9.0 fixtures contain 2 synthetic organizations, 80 customers, 100 documents, 300 revisions, 600 chunks, 200 tickets, 900 conversation messages, 60 drafts/citations and 10 failed replacement jobs. Fixed seed, reference date, deterministic identifiers, source timestamps and vectors make complete reseeds repeatable. There are no imported customer records or seeded bearer credentials.

## Commands and results

| Executed check                                                                         | Result                                                                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                       | Eight workspace projects installed from the lockfile                                                                     |
| `pnpm audit --prod --audit-level high`                                                 | No known production vulnerabilities reported                                                                             |
| `pnpm check`                                                                           | Format, ESLint, strict types, 11 REST/controller operations, SDL/client operations and **27 unit/contract tests passed** |
| `pnpm build`                                                                           | All seven packages/services built, including Next.js production output                                                   |
| `pnpm contracts:drift`                                                                 | Generated REST/GraphQL output unchanged                                                                                  |
| `pnpm db:migrate`                                                                      | Existing local schema expanded; subsequent reapply returned already current                                              |
| `pnpm db:bootstrap --database resolvehub_m03_verify_20261020a --seed`                  | New local database created, migrated and seeded; final forward migration subsequently applied                            |
| ESM runner invoking `seedSynthetic` twice against that bootstrap database              | Both runs returned 2 organizations, 100 documents, 200 tickets, 300 versions and 900 messages                            |
| Final compiled `pnpm start`, isolated ports 3100–3102; `scripts/wait-for-services.mjs` | All services ready against latest migration/configuration                                                                |
| `pnpm test:integration`, isolated compiled stack                                       | **34 tests passed**, four suites                                                                                         |
| `pnpm smoke`, isolated compiled stack                                                  | Web/API/worker healthy; actual BullMQ probe processed with duplicate ID preserved                                        |
| `pnpm test:e2e`, isolated compiled stack                                               | **Six desktop/mobile browser tests passed**                                                                              |
| `git diff --check`                                                                     | No whitespace errors                                                                                                     |

**67 unique automated tests passed** across the unit/contract, integration and browser suites. Repeated verification runs are not counted as additional tests. No retrieval latency, semantic recall or production scale benchmark is claimed.

Migration/persistence integration uses disposable isolated schemas, applies initial SQL, exercises initial rollback and reinstall, upgrades existing tickets/pending ingestion, verifies repeat application and rejects checksum tampering. It compares Drizzle columns/types/nullability and tenant policies with PostgreSQL. It hashes every row across complete reseeds, preserves an unrelated organization, rejects cross-tenant FKs and duplicate revisions, and verifies retrieval-index availability with `EXPLAIN` under an index-favoring planner setting. That planner probe establishes index eligibility, not normal workload performance.

Isolation checks use an actual `NOSUPERUSER NOBYPASSRLS` non-owner role: missing context returns no domain rows, tenant A cannot read/update tenant B, and cross-tenant insertion fails. The actual runtime grant script is also exercised through authentication, webhook identity lookup, ticket creation/idempotency/audit and vector retrieval. Runtime cannot update audit history; transaction-local context does not leak into pooled reads. Temporary schema/role resources are cleaned up.

Publication checks cover failed/incomplete replacement preserving the old index, a later audit write failure rolling back all publication writes, concurrent duplicate publication producing one audit, superseding the old version and version deletion. Deleted documents, chunks and versions disappear from vector/lexical/evidence queries, even when a privileged direct version deletion leaves an active pointer. Deleted tickets hide their messages and drafts. Wrong vector dimensions/model IDs fail in both application and database checks.

## Corrections during verification

The first schema/seed run found a missing snake-case mapping for `audit_events.actor_kind`; it was corrected in Drizzle. Reseed hashing found normalized citation timestamps were using wall-clock defaults; forward migration 0005 preserves their source timestamps. Isolated-schema vector queries required `OPERATOR(public.<=>)` to find the pgvector operator. Migration review found legacy pending ingestion versions needed to inherit the document state; forward migration 0006 and an upgrade regression test preserve that handoff. All affected checks passed afterward.

A sandboxed `pnpm check` attempt hit tsx's local IPC restriction; the same checks passed with permitted local process access. A one-off `tsx --eval` diagnostic used CJS resolution against an ESM-only workspace export and failed before database work; the diagnostic was rerun successfully with `node --import tsx --input-type=module`. Normal project scripts and builds use ESM correctly.

## Limits and handoff

The embedding model is **resolvehub-synthetic-sha256-v1, 64 dimensions**. It is implemented deterministic test tooling, not semantic AI or a live provider. Existing legacy chunks remain without fabricated embeddings. A different model/dimension requires an adapter, a new migration and reindexing. Synthetic object metadata does not create MinIO upload objects.

The Compose owner account remains local administrative convenience; deployment must provision the separate non-owner runtime login described in the database runbook. Database policies defend missing tenant predicates, while verified application identity remains the authorization boundary. This is not a deployed production security claim.

Indexing processors, durable failed-job DLQ, provider generation and semantic quality/evaluations retain later milestones. Failed job fixtures do not claim those pipelines work. Dashboard data/sign-in wiring remains deferred. The initial rollback script is only for a disposable 0001-only schema; live expanded data requires a verified backup/restore procedure. Large live-dataset lock/backfill behavior has not been benchmarked.

The disposable bootstrap database `resolvehub_m03_verify_20261020a` was retained locally with synthetic data and all migrations. The ordinary database was migrated without automatically loading demo tenants. The isolated verification processes were stopped after checks; the pre-existing development stack and Compose volumes were preserved. Restart an existing development process to reload shared compiled exports.
