# Milestone 01 verification

Verified on **2026-10-20 (Asia/Manila)** on macOS arm64, Node 22.22.3, pnpm 12.10.1, Docker Engine 29.8.0 and Compose v5.5.1. This is evidence for local scaffolding, not a production-readiness or tenant-isolation certification.

## Implemented scope

- All requested top-level workspaces/directories, strict TypeScript, ESLint, Prettier, Turborepo task ordering, pinned pnpm lockfile and a Makefile.
- Next.js App Router dashboard: Tickets, Knowledge Base, Review Queue, Settings; real navigation, active state, keyboard skip link, responsive layout, explicit unavailable workflows and working health refresh/error handling.
- NestJS API liveness/readiness, request IDs, safe typed errors, Helmet, explicit CORS origin, 64 KB JSON limit, validated configuration and graceful shutdown.
- Separate BullMQ consumer with validated system probes, bounded concurrency, finite probe retention, liveness/readiness and shutdown.
- Shared runtime health/job contracts, generated OpenAPI 3.1 health client, Drizzle/PostgreSQL pool and an abstaining mock AI provider.
- Loopback-only PostgreSQL/pgvector, Redis and MinIO Compose services with persistent volumes and health checks. No volumes were deleted during verification.
- `AGENTS.md`, setup/architecture/operations documents and a basic GitHub Actions foundation workflow. The existing `CODEX.md` specification is preserved without changes.

## Commands and observed results

| Command or check                                       | Observed result                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                       | Pass; all eight workspace projects installed from the lockfile                                                                                                                                                     |
| `pnpm check`                                           | Pass; format, ESLint without warnings, strict typecheck across all seven packages/apps/services plus tests/scripts, 14 Jest unit/contract tests                                                                    |
| `pnpm build`                                           | Pass; all seven build tasks, including production Next.js route generation                                                                                                                                         |
| `pnpm generate`                                        | Pass; health client regenerated deterministically (SHA-256 `112d67c7d47cb349085982be8a4026818b92d08e7e79ec7f9115d43683e4fb3a`)                                                                                     |
| `docker compose config --quiet`                        | Pass; environment interpolation/configuration valid                                                                                                                                                                |
| `docker compose --progress plain up -d --build --wait` | Pass after the documented MinIO source-build adjustment                                                                                                                                                            |
| `docker compose --progress plain up -d --wait`         | Pass with pinned PostgreSQL/Redis digests; all three containers healthy                                                                                                                                            |
| `pnpm dev`                                             | Pass; dashboard on 3000, API on 3001, standalone worker on 3002                                                                                                                                                    |
| `pnpm start` and `node scripts/wait-for-services.mjs`  | Pass; all three compiled processes become ready; start commands set `NODE_ENV=production`                                                                                                                          |
| `pnpm smoke`                                           | Pass against development and compiled processes; real queue consumption, correlated result and duplicate job-ID check                                                                                              |
| `pnpm test:integration`                                | 5 passed: API/worker health, safe correlated 404, actual vector distance query, 413 payload rejection                                                                                                              |
| `pnpm test:e2e`                                        | 6 passed in installed Chrome: navigation/health refresh, unavailable health error and keyboard skip link, each on desktop and emulated mobile                                                                      |
| Redis outage/recovery                                  | Stopped this project's Redis; both readiness endpoints returned 503 with Redis down while both liveness endpoints returned 200; restarted Redis, observed automatic readiness recovery and processed another probe |
| `pnpm audit --prod --audit-level high`                 | Pass; no known production dependency advisories after upgrading Drizzle to a patched release                                                                                                                       |

Browser navigation checks also assert no uncaught page errors and no horizontal overflow. Desktop and mobile screenshots were rendered and visually inspected; a narrow mobile banner was corrected following that inspection. Mobile checks use Chromium emulation, not a physical device. Screenshots: [desktop](dashboard-desktop.png), [mobile](dashboard-mobile.png).

## Resolved setup issues and explicit limits

- Docker Desktop was installed but stopped; started it and verified the engine before bringing up Compose.
- pnpm required an explicit `@parcel/watcher` lifecycle-script decision; the workspace now declares its native build allowlist.
- MinIO Docker Hub/Quay image pulls failed. Built its official release from immutable upstream source; see [decision 0001](../architecture/decisions/0001-local-minio-source-build.md).
- Turbopack's production CSS subprocess failed to bind a local port, including on a permission-enabled retry. The supported Webpack production build passes; see [decision 0002](../architecture/decisions/0002-webpack-production-build.md).
- Browser QA exposed a missing accessible name for the mobile Settings icon; corrected it and reran navigation successfully.
- Full development dependency audit reports one moderate `sprintf-js` advisory through Jest's coverage tooling, with no patched version listed. It is development-only; the production audit is clean. Track upstream [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
- GitHub Actions is authored but has not run remotely; no repository remote, deployment, registry publication, live AI benchmark or physical-device test was performed.
- Authentication, tenant domain access, GraphQL/domain contracts, database schema/migrations/seeds, uploads/indexing, durable domain DLQ, AI retrieval/citation/approval, production images and telemetry are reserved for their specified milestones. No application migration or tenant-isolation result is claimed here.

Next milestone: canonical authenticated REST/GraphQL contracts, verified membership, tenant context, pagination and domain idempotency. Keep the local infrastructure and package boundaries established here.

Application verification processes and Compose containers were stopped after checks; named data volumes were retained. Start the workspace again with `make up` and `make dev`.
