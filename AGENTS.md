# ResolveHub engineering rules

Read this file and `CODEX.md` before editing. Implement only the requested milestone. The specification describes the target; never present unimplemented features as working.

## Coding and verification

- Use pnpm workspaces, Turborepo, strict TypeScript, ESLint and Prettier. Keep the lockfile committed. Use Node from `.nvmrc` and pnpm from `packageManager`.
- Prefer small, typed functions and explicit dependency injection. Validate external input with runtime schemas; do not use `any`, unchecked casts or non-null assertions to hide errors.
- Run `pnpm check` and the appropriate build/integration checks before a milestone commit. Record actual commands, failures and limits in `docs/verification/`. Never invent verification results.
- Every visible action must work or be disabled with a clear reason. Empty states must distinguish unavailable features, no records and dependency failures. Do not seed deceptive production data.

## Architecture boundaries

- `apps/web`: presentation and a server-side API client. No direct database, Redis, storage, provider credentials or domain decisions in React views. Browser code must not import server-only modules.
- `services/api`: authentication, authorization and application orchestration. Transport controllers validate/delegate; domain services own policy and transactions. Only API authorizes external mutations.
- `services/worker`: bounded, asynchronous adapters. Jobs carry immutable tenant/resource identifiers and validated payloads; workers reload authoritative state. Never trust a queued authorization claim.
- `packages/contracts`: transport schemas and canonical OpenAPI/GraphQL documents. No service or database imports.
- `packages/generated`: generated types and client wrappers only. Run `pnpm generate`; never hand-edit `src/rest.ts`. Contract drift fails CI.
- `packages/db`: Drizzle schema, migrations and scoped repositories. No web or AI dependencies. `packages/ai`: provider abstractions, retrieval and evidence validation; no HTTP controllers or direct user authorization.
- Shared packages must not import apps/services. Keep service-specific environment schemas inside each service. Add dependencies only when used.

## Tenant isolation and security

- All domain access must use server-derived organization context from a verified session/token and membership. A request-supplied tenant ID is never authorization. No domain routes may ship before authentication and isolation tests.
- Scope every read, write, cache key, vector query, object key and job to the organization. Use composite tenant keys and defensive PostgreSQL policies where appropriate. Return 404 for inaccessible resource identifiers.
- Public health endpoints expose only component names/status; never connection URLs, secrets, exception messages or customer content. Liveness and dependency readiness must be distinct.
- Validate environment at startup; fail with field names, never values. Keep secrets out of Git, client bundles and logs. Production deployment must use distinct least-privilege credentials, TLS and explicit origins.
- Set payload limits, timeouts and bounded retries. Verify webhook signatures and timestamps before mutation. Treat uploaded/retrieved text and model output as untrusted data. Human approval is mandatory before sending a reply.

## Idempotency and failure handling

- Assume at-least-once delivery. Tenant-scope idempotency records, enforce unique keys, compare payload hashes, and return 409 on conflicting reuse. Store state and audit changes transactionally.
- Queue workers must tolerate duplicates and shutdown cleanly. Use four total attempts, exponential backoff with jitter, and finite retention. Terminal domain failures require a durable application DLQ before domain jobs ship; Redis retention alone is not a DLQ.
- Preserve the prior active document index until the replacement commits atomically. Replay must reauthorize, audit and remain idempotent.
- Return typed `{ code, message, requestId, details? }` errors. Do not leak stack traces or provider internals. Distinguish invalid input, conflicts, authorization and dependency failure. Preserve request IDs across boundaries.
- Never silently replace a failed dependency with fabricated success or customer data. UI must show explicit unavailable/retry states.

## Tests, migrations and delivery

- Use Jest for meaningful policy/unit/contract checks and real infrastructure for integration checks. Use Testcontainers for domain integration suites. Test cross-tenant denial, retries, duplicate jobs and partial failures before related features ship.
- `pnpm test` runs units/contracts without infrastructure. `pnpm test:coverage` owns isolated Testcontainers and must pass for critical service changes; preserve the independent 80% branch gates. Never point these integration tests at a developer database or load `.env`. Use deterministic synthetic fixtures and mock AI; normal CI must make no paid provider calls.
- Browser tests cover navigation, keyboard access, loading/empty/error states and responsive behavior. Deterministic mock AI must never claim evidence or confidence it does not have.
- Apply numbered SQL migrations through the migration runner, not application startup. Never edit an applied migration. Use expand → migrate → contract, with backup/recovery notes for destructive changes. Bootstrap extensions under `infra/docker` are not application migrations.
- Embedding dimensions and model versions must come from verified provider configuration. Dimension changes require explicit data/migration planning.
- CI must use frozen installs and generated-client drift checks. Do not publish/deploy as part of local scaffolding. Commit milestones as `milestone(N): <description>` and keep unrelated changes out of the commit.
