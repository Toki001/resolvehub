# Contracts

`openapi.yaml` is the canonical OpenAPI 3.1 command/health contract. `schema.graphql` is the schema-first read contract; `operations/workspace.graphql` contains executable client operations. No tenant ID is accepted as authority. `src/index.ts` exports shared health/error/probe schemas.

Run `pnpm generate` after either contract or operation changes and commit all generated sources. REST request validators load the canonical JSON Schemas directly. `pnpm contracts:check` validates both contracts, all client operations, and the exact REST controller inventory. CI fails on generated drift and real HTTP contract/isolation test failures.
