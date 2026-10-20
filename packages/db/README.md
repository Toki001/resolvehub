# Database package

Exports a bounded `pg` connection pool and Drizzle client; the service owns shutdown. There are no domain tables or migrations in this foundation release. Only the `vector` extension is bootstrapped by local Compose.

The data milestone will add `schema/`, numbered `migrations/` and deterministic `seeds/`, tenant-aware keys/repositories and a migration runner. Do not create customer tables through service startup or the infrastructure bootstrap file.
