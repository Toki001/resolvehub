# Database operations

Use PostgreSQL 17 with pgvector installed in `public`. Compose supplies the pinned image. Migrations create the extension on a clean database when the administrative role has permission; managed services may require their extension administrator first. Application startup only checks readiness.

```sh
pnpm db:migrate
pnpm db:migrate       # verifies checksums and does no further work
pnpm db:bootstrap --database resolvehub_synthetic --seed
```

Bootstrap creates a **new** local database, installs all migrations and optionally seeds it. It refuses an existing database, non-local URLs and production mode; it never drops a database. Set `DATABASE_URL` to that database to use it. An unsuccessful bootstrap retains the new database for inspection. Use a unique database name when repeating the bootstrap check.

`pnpm db:seed` populates the database named by `DATABASE_URL`. It replaces only the two reserved fixture organizations, transactionally, after checking their expected names. Existing content created inside those synthetic organizations is replaced; unrelated organizations are preserved. A collision with a different organization name aborts the whole transaction. Production mode and remote hosts are refused. There are no seeded bearer tokens, webhook secrets or automatic sign-in credentials. Provision an expiring credential with `pnpm auth:bootstrap --organization-id <fixture-organization-uuid> --subject admin@org-0.example.test`; see [API operations](contract-apis.md).

The corpus uses Faker **9.9.0**, seed **3102026**, reference time **2026-01-15T12:00:00.000Z**, and reserved `.example.test` emails. It contains exactly 2 organizations, 80 customers, 100 documents, 300 revisions, 600 chunks, 200 tickets, 900 conversation messages, 60 drafts/citations and 10 failed replacement jobs. Obsolete articles deliberately contain misleading advice. Only current indexed revisions are retrieved. All text, names, IDs and vectors are synthetic; no real records or external provider calls are used. Integration checks hash all persisted fixture rows across a reseed and preserve an unrelated organization.

## Runtime database credentials

Compose's owner account is local administrative convenience. Production API credentials must be a separate `LOGIN NOSUPERUSER NOBYPASSRLS` that owns no tables and inherits `resolvehub_runtime`. Run `infra/docker/runtime-grants.sql` as the migration administrator after migration, in the target schema. Create the login and password through the deployment's secret manager, then grant that login membership in `resolvehub_runtime`. Never reuse the table owner for API traffic. Use administrative `DATABASE_URL` only in migration/provisioning jobs, and the runtime URL in the API environment.

The grant file gives read-only access to credential/integration bootstrap lookups and configuration; business tables use tenant policies, and audit history permits select/insert only. It grants no migration, credential mutation or schema creation capability. Runtime queries require a transaction-local `resolvehub.organization_id` set from verified server identity; a missing context returns no domain rows. RLS is defense against missing predicates, not against a compromised application allowed to choose its own session context. Tests use both a fresh non-owner role and the actual runtime grant script.

`EMBEDDING_MODEL=resolvehub-synthetic-sha256-v1` and `EMBEDDING_DIMENSIONS=64` describe the current implemented test model. Defaults are the same for upgrades of existing local `.env` files. Invalid configuration fails without printing values; API readiness checks the database model/dimension pair and latest migration. PostgreSQL enforces `vector(64)` and the configured model FK. Legacy chunks have no fabricated embeddings. To introduce a real provider, add its adapter, new versioned storage/configuration, backfill vectors, validate retrieval and switch publication atomically. Do not alter an applied migration or change only the environment.

## Migration and rollback procedure

The runner takes a transaction advisory lock, verifies SHA-256 checksums and commits the ordered batch atomically. Use a tested backup and a maintenance window for this initial corpus; the expansion backfills and index builds take locks. Large deployments should split long backfills and create indexes concurrently in dedicated non-transactional migration tooling before rollout. This batch runner intentionally does not support `CREATE INDEX CONCURRENTLY` inside its transaction.

1. Back up the target database with `pg_dump --format=custom --file=<protected-backup-path> <admin-connection>`. Verify restore into a separate database with `pg_restore`, and record the applied migration names/checksums without logging connection secrets.
2. Apply forward migrations using the migration administrator before rolling new API binaries. Migrations 0003/0004 expand customers and evidence, backfill them, validate the customer reference and keep old-write compatibility. 0005 preserves citation source timestamps; 0006 retains legacy pending ingestion states. Existing ticket/ingestion data and active publications survive the upgrade test.
3. Reapply to verify no-op behavior, check readiness, run migration/isolation tests and roll API traffic. Keep compatibility fields/adapters through the old binary's retirement. Then schedule their removal in a new migration after backup and dependency review.
4. If application rollout fails, restore the previous application binary while keeping the compatible expanded schema. Do not run reverse SQL on live expanded data. A data rollback requires restoring the verified backup into a separate database, reconciling writes since the backup and an explicit controlled cutover.

For an **initial disposable install containing only 0001**, `packages/db/rollback/0001_initial.sql` transactionally removes its application tables and receipt. It refuses any database with later migrations. Verify the target connection before executing it. This procedure is destructive, retains pgvector and migration bookkeeping, and is tested by reinstalling 0001 afterward. It is not a rollback for production data or milestone 03. Never erase migration history to bypass a checksum failure; restore the original SQL or add a forward repair.

`pnpm test:integration --runTestsByPath tests/integration/migrations.test.ts tests/integration/persistence.test.ts` creates isolated schemas, tests clean/repeated/forward migration, initial rollback/refusal, model parity, non-owner RLS, seed repeatability, tenant FKs, vector configuration and atomic publication/deletion. It requires administrative local test access to create schemas and temporary test roles. Schema and role cleanup is restricted to resources created by the suite.
