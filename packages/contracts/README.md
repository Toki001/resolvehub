# Contracts

`openapi.yaml` is the canonical OpenAPI 3.1 health contract for milestone 01. `src/index.ts` exports runtime health schemas and operational queue probe schemas. No tenant/domain endpoints are exposed yet.

Run `pnpm generate` from the repository root after an OpenAPI change. Commit the resulting `packages/generated/src/rest.ts`. Schema-first GraphQL and domain REST contracts arrive together in milestone 02.
