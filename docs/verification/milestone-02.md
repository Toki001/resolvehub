# Milestone 02 verification

Verified on **2026-10-20 (Asia/Manila)** with Node 22.22.3, pnpm 12.10.1, Docker Engine 29.8.0, Compose v5.5.1 and PostgreSQL 17/pgvector. This verifies the contract API milestone on local synthetic data; it is not production deployment or complete RLS/AI verification.

## Implemented scope

- Canonical OpenAPI 3.1 defines 11 REST operations: health, identity, ticket creation, ingestion requests, draft requests, job status/replay, review decisions and signed webhook receipts.
- Canonical schema-first SDL defines six read roots and their connections, details, knowledge matches, drafts and summary types. Nest Apollo on Express loads that file directly.
- openapi-typescript/openapi-fetch REST client and GraphQL Code Generator **client preset** typed documents are generated and tracked. ESM imports use explicit `.js` extensions.
- Runtime REST validation uses the canonical JSON Schemas. Controller inventory and executable GraphQL operations are checked against their contracts; CI fails on generated changes/deletions or untracked output.
- Real hashed, expiring/revocable bearer credentials resolve active membership and organization server-side. Roles guard commands/replay. Webhooks use server-side integration identity, encrypted signing secrets, exact-byte HMAC, five-minute timestamp tolerance and event deduplication.
- Opaque AES-GCM cursors bind organization, operation, filters, cutoff and ordering tuple; default page size is 20, maximum 100, with immutable millisecond timestamp/UUID order and 24-hour cursor expiry.
- Tenant-scoped transactions persist ticket/message writes, accepted async requests, original idempotency receipts and audit history. Concurrent duplicate keys serialize; conflicts are 409. Review checks revisions and current owned evidence, and never sends a message.
- Minimal numbered migrations support real handlers. Migration 0002 fixes reviewer-reference cascade timing and adds a single replay child per failed source without editing applied migration 0001.

## Commands and results

| Command/check                            | Observed result                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`         | Pass across all eight workspaces; final lockfile verified                                                                                                                                                                              |
| `pnpm check`                             | Pass: formatting, ESLint without warnings, strict types for all workspaces/tests/scripts, canonical contract validation, 23 unit/contract tests in six suites                                                                          |
| `pnpm contracts:check`                   | OpenAPI 3.1 valid, all 11 declared REST operations exactly match controllers, SDL and all six generated client operations validate                                                                                                     |
| `pnpm generate` / `pnpm contracts:drift` | Pass; regenerated REST and GraphQL sources match staged/committed output                                                                                                                                                               |
| Intentional REST drift probe             | Added a temporary schema property; drift command failed with the REST generated diff, as expected; restored exact source/output                                                                                                        |
| Intentional GraphQL drift probe          | Temporarily changed a client operation; drift command failed with GraphQL generated diffs, as expected; restored exact source/output                                                                                                   |
| `pnpm db:migrate` twice                  | Outstanding numbered SQL applied; repeat reported migrations current                                                                                                                                                                   |
| Migration integration test               | Clean scratch-schema install, preserved ticket through additive expansion, repeated application, checksum rejection for an altered isolated copy; scratch schema/files removed                                                         |
| `pnpm build`                             | All seven build tasks pass, including production Next.js; final API compilation also passes                                                                                                                                            |
| Compiled `pnpm start` and readiness wait | Web/API/worker all ready on isolated ports 3100/3101/3102                                                                                                                                                                              |
| `pnpm test:integration`                  | 23 passed in three suites against the compiled API and actual PostgreSQL/worker                                                                                                                                                        |
| `pnpm smoke`                             | Web/API/worker healthy; actual standalone BullMQ probe consumed with correlated result and duplicate job-ID check                                                                                                                      |
| `pnpm test:e2e`                          | Six passed in desktop and emulated mobile Chrome: navigation/health refresh, explicit error states, keyboard skip link; no uncaught page errors or overflow                                                                            |
| Offline provisioning/rotation exercise   | Created a synthetic organization/credential/integration; authenticated, accepted a signed webhook, rotated the credential, verified old token 401/new token 200; secrets never printed to verification output and organization removed |
| `pnpm audit --prod --audit-level high`   | Pass; no known production dependency advisories                                                                                                                                                                                        |

The 23 HTTP/migration integration tests cover actual generated REST client use; every GraphQL root; missing/expired/revoked credentials and inactive membership; role denial before receipt replay; forged tenant fields/headers; cross-tenant resource/job/cursor denial; published-version-only search; stable pagination ties and bounded work; concurrent idempotency and rollback; signed/tampered/stale/future/oversized webhooks; UUID-case event deduplication; review evidence/revision/state checks and single audited decisions; and admin-only deduplicated replay. All synthetic organizations are removed after tests.

First-run environment setup is separately tested to create a private key, preserve it on repeat, set mode 0600, and fail without overwriting invalid existing secrets. Query-budget checks include supplied variables, operation defaults and nested expansion. **Total: 52 passing automated tests**, plus the smoke, negative drift and provisioning exercises.

## Limits and handoff

- Async endpoints durably accept requests; `accepted` does not imply processing or completion. Domain ingestion/drafting processors, dispatch/DLQ and replay execution remain later milestones. The existing BullMQ worker processes system probes only.
- Object uploads/presigned URLs, full Drizzle modeling, runtime database roles/RLS, complete fixtures and publication workflow remain milestone 03 or later. The current local owner role is not a production runtime role.
- Knowledge search is literal matching against active published chunks; vector retrieval, grounded generation, semantic citation validation and AI cost/evaluation metrics are deferred. Reviewed drafts in tests are explicitly synthetic fixtures.
- The dashboard retains its foundation shell; customer data/sign-in wiring is not part of this API milestone. Browser checks use emulation, not physical hardware.
- GitHub Actions gates are authored and verified locally, but have not run remotely. Nothing was published or deployed.
- A pre-existing development stack was watching this checkout. Final validation used isolated compiled ports instead of taking over that session. Restart existing development processes after `make setup` / `make migrate` so they load the new environment and shared outputs.
- The review cleanup failure found during initial tests was fixed with a forward migration and verified by subsequent cleanup and migration checks. No application volumes were deleted.

Next: milestone 03 data modeling, database privileges/RLS, deterministic fixture corpus and publication invariants. See [API operations](../operations/contract-apis.md) and [architecture decision 0003](../architecture/decisions/0003-contract-api-persistence-and-auth.md).

The recursive REST inventory also rejected a temporary undeclared controller in a nested feature directory, then passed after that probe was removed. Isolated verification processes were stopped after validation; pre-existing development processes and infrastructure were left running.
