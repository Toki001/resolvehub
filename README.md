# ResolveHub

A multi-tenant AI customer support platform, built one verified milestone at a time. **This repository implements milestone 01: the local foundation.** The full roadmap is in [CODEX.md](CODEX.md); engineering rules are in [AGENTS.md](AGENTS.md).

The dashboard has working Tickets, Knowledge Base, Review Queue and Settings navigation, explicit scope/empty/error states, and live dependency health. NestJS and a separate BullMQ worker run as independent processes. There are no customer records, enabled domain mutations, pretend upload controls or autonomous messages.

![Tickets workspace](docs/verification/dashboard-desktop.png)

## Start locally

Prerequisites: Node **22.22.3**, pnpm **12.10.1**, Docker with Compose v2 or later. Use `.nvmrc` with your Node version manager. Install pnpm with `npm install --global pnpm@12.10.1` if needed.

```sh
make setup         # creates an ignored .env if missing; frozen dependency install
make up            # PostgreSQL/pgvector, Redis and MinIO; waits for health checks
make dev           # Next.js, NestJS and the separate worker via Turborepo
```

Open **http://localhost:3000**. Settings → System health checks the real services. All credentials in `.env.example` are local infrastructure credentials, not user accounts. Authentication and organization membership are deliberately deferred to milestone 02; there is no synthetic sign-in or trusted tenant header.

The first `make up` builds MinIO from a pinned official source commit because the public community images could not be pulled. It needs internet access and can take several minutes. See the [decision record](docs/architecture/decisions/0001-local-minio-source-build.md).

For compiled application startup:

```sh
pnpm build
pnpm start
```

Run only one application stack at a time. Stop it with Ctrl+C. `make down` stops infrastructure and preserves named volumes. Ports bind to loopback only. This development configuration is not a production deployment.

## Commands

| Command                          | Purpose                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Reproduce all eight workspace projects from the lockfile                                 |
| `pnpm dev`                       | Build shared dependencies, then watch all applications                                   |
| `pnpm check`                     | Formatting, ESLint, strict typecheck, Jest unit/contract checks                          |
| `pnpm build`                     | Compile every package/service and production Next.js output                              |
| `pnpm generate`                  | Regenerate the REST health client from OpenAPI                                           |
| `pnpm smoke`                     | Check web/API/worker readiness, process a real BullMQ probe and check duplicate job IDs  |
| `pnpm test:integration`          | Exercise running services and the actual pgvector extension                              |
| `pnpm test:e2e`                  | Browser navigation, responsive layout and health-error checks; requires installed Chrome |
| `pnpm infra:check`               | Validate Compose without starting containers                                             |
| `pnpm infra:down`                | Stop infrastructure without deleting data                                                |

Smoke, integration and browser checks require `make up` and a running `pnpm dev` or `pnpm start` in another terminal. Unit checks need no external services. Changes to shared packages require restarting `pnpm dev` to rebuild their compiled exports.

## Workspace layout

```text
apps/web/              Next.js App Router, React, Tailwind
services/api/          NestJS REST health endpoints; application boundary
services/worker/       Standalone TypeScript BullMQ consumer and health server
packages/contracts/   Runtime schemas, OpenAPI 3.1 operational contract
packages/generated/   Generated REST types and typed client
packages/db/          Drizzle/PostgreSQL connection lifecycle
packages/ai/          Provider interface and deterministic abstaining mock
tests/                Jest unit/contract/integration and Playwright checks
infra/                Local PostgreSQL bootstrap and MinIO source Dockerfile
docs/                 Architecture, operations, verification evidence
.github/workflows/    Foundation CI checks
```

The [architecture guide](docs/architecture/README.md) describes ownership and planned tenant boundaries. The [local operations guide](docs/operations/local-development.md) covers configuration, health semantics, outages and recovery. [Milestone verification](docs/verification/milestone-01.md) records actual checks and limits.

Milestone 02 is next: canonical domain REST/GraphQL contracts, verified membership and authenticated operations. Domain schemas/migrations/seeds, indexing and durable failure handling, evidence-grounded AI, release automation and telemetry remain in their specified milestones. No benchmarks or production-readiness claims are made for this scaffold.
