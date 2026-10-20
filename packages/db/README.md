# Database package

`src/schema.ts` exports the typed Drizzle models, composite relationships, indexes and tenant policies. `src/knowledge.ts` implements scoped exact pgvector retrieval and transactional publication/deletion with Drizzle. `src/store.ts` retains the parameterized contract repositories, durable mutation receipts and authentication lookups. `src/tenant.ts` sets tenant context with `SET LOCAL` inside a transaction; context cannot escape back into the pool.

Numbered SQL in `migrations/` is the DDL authority. Run `pnpm db:migrate` explicitly; application startup never migrates. Applied checksums are immutable. SQL additionally expresses deferred circular foreign keys, compatibility adapters and lifecycle triggers that Drizzle cannot fully describe. Integration tests compare model columns/types/nullability and policies with actual PostgreSQL and exercise the database constraints.

The model/dimension pair in `embedding_configuration` is pinned to `resolvehub-synthetic-sha256-v1`, **64** dimensions. This is an implemented synthetic test-vector algorithm, not semantic AI. Configuration mismatches fail at startup; database FKs and `vector(64)` reject incompatible storage. Existing pre-vector evidence stays nullable until explicitly reindexed. A real provider requires an implemented adapter, a new migration and reindexing.

See [database operations](../../docs/operations/database.md) for bootstrap, deterministic fixtures, least-privilege credentials, migrations and rollback. Fixtures are explicit local tooling; never run automatically on service startup or in production.
