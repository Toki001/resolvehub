# Database package

Exports the bounded PostgreSQL/Drizzle connection lifecycle, explicit checksum-aware migration runner and tenant-scoped repositories for milestone 02. Minimal normalized storage supports credentials/membership, tickets/messages, document requests, current knowledge, drafts/reviews, accepted jobs, idempotency receipts and audit history.

Run `pnpm db:migrate`; startup never migrates. Applied SQL must stay immutable. Migrations 0001/0002 establish contract handler persistence and replay/review integrity. Query SQL is parameterized and organization-scoped; composite foreign keys protect relationships. The complete Drizzle schema, least-privilege runtime role/RLS, publication flow, seed corpus and full migration evolution verification remain in milestone 03. See architecture decision 0003 for the bounded persistence introduced here.
