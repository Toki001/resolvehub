# ResolveHub

A multi-tenant AI customer support platform, built one verified milestone at a time. **Milestones 01–08 provide authenticated contract APIs, versioned persistence, durable ingestion, automated verification, evidence-bound support drafting, CI/CD and private operational telemetry.** The full roadmap is in [CODEX.md](CODEX.md); engineering rules are in [AGENTS.md](AGENTS.md).

The dashboard retains its foundation shell with working navigation and live health. The API supports tenant-authenticated REST commands and schema-first GraphQL reads, generated clients, durable idempotency, signed webhook receipts and audited review. No customer data is seeded automatically. Document ingestion runs through MinIO, validated extraction/chunking, deterministic embeddings and atomic publication, with bounded BullMQ retries and a PostgreSQL dead-letter queue. Support draft jobs now retrieve tenant-filtered published evidence and produce cited pending drafts or explicit abstentions. Generation uses the deterministic extractive mock by default, with an optional Ollama adapter. Webhook domain processing and outbound delivery remain deferred.

![Tickets workspace](docs/verification/dashboard-desktop.png)

## Start locally

Prerequisites: Node **22.22.3**, pnpm **12.10.1**, Docker with Compose v2 or later. Use `.nvmrc` with your Node version manager. Install pnpm with `npm install --global pnpm@12.10.1` if needed.

```sh
make setup         # creates an ignored .env if missing; frozen dependency install
make up            # PostgreSQL/pgvector, Redis and MinIO; waits for health checks
make migrate       # explicit, checksum-verified numbered SQL migrations
make dev           # Next.js, NestJS and the separate worker via Turborepo
```

Open **http://localhost:3000**. Settings → System health checks the real services. `make setup` generates a private API secret in ignored `.env`; example infrastructure values are for local use only. Provision expiring API credentials with `pnpm auth:bootstrap`; see the [API operations guide](docs/operations/contract-apis.md). Dashboard sign-in and data wiring remain future work. API callers use verified bearer credentials, never a trusted tenant header.

The first `make up` builds MinIO from a pinned official source commit because the public community images could not be pulled. It needs internet access and can take several minutes. See the [decision record](docs/architecture/decisions/0001-local-minio-source-build.md).

For compiled application startup:

```sh
pnpm build
pnpm start
```

Run only one application stack at a time. Stop it with Ctrl+C. `make down` stops infrastructure and preserves named volumes. Ports bind to loopback only. This development configuration is not a production deployment.

## Commands

| Command                                                    | Purpose                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                           | Reproduce all nine workspace projects from the lockfile                                    |
| `pnpm dev`                                                 | Build shared dependencies, then watch all applications                                     |
| `pnpm check`                                               | Format, lint, strict types, canonical contracts/controller validation, unit/contract tests |
| `pnpm build`                                               | Compile every package/service and production Next.js output                                |
| `pnpm generate`                                            | Regenerate the REST client and typed GraphQL documents                                     |
| `pnpm contracts:drift`                                     | Reject changed, deleted or untracked generated output                                      |
| `pnpm db:seed`                                             | Replace the two reserved synthetic organizations in a local database                       |
| `pnpm db:bootstrap --database resolvehub_synthetic --seed` | Create a new local database, migrate and seed it                                           |
| `pnpm db:migrate`                                          | Apply outstanding checksum-verified SQL migrations                                         |
| `pnpm smoke`                                               | Check web/API/worker readiness, process a real BullMQ probe and check duplicate job IDs    |
| `pnpm test` / `pnpm test:unit`                             | Jest unit and contract tests without Docker                                                |
| `pnpm typecheck`                                           | Strict workspace and test TypeScript checks                                                |
| `pnpm test:coverage` / `pnpm test:all`                     | Combined suite, isolated infrastructure and 80% branch gates per critical area             |
| `pnpm test:integration`                                    | Self-contained NestJS, PostgreSQL/Redis/MinIO Testcontainers and failure injection         |
| `pnpm test:e2e`                                            | Browser navigation, responsive layout and health-error checks; requires installed Chrome   |
| `pnpm infra:check`                                         | Validate Compose without starting containers                                               |
| `pnpm infra:down`                                          | Stop infrastructure without deleting data                                                  |

Smoke and browser checks require `make up` and a running `pnpm dev` or `pnpm start` in another terminal. Unit checks need no external services. Integration and coverage commands need Docker; they build the services, create disposable containers, run migrations and clean up automatically. They never load `.env`. The first run builds the pinned MinIO image if missing. See [automated verification](docs/operations/verification.md). Changes to shared packages require restarting `pnpm dev` to rebuild their compiled exports.

## Workspace layout

```text
apps/web/              Next.js App Router, React, Tailwind
services/api/          NestJS REST commands and schema-first GraphQL reads
services/worker/       Standalone TypeScript BullMQ consumer and health server
packages/contracts/   OpenAPI 3.1, GraphQL SDL and executable operation documents
packages/generated/   Generated REST client and typed GraphQL documents
packages/db/          PostgreSQL/Drizzle lifecycle, migrations and scoped repositories
packages/ai/          Embedding provider and deterministic abstaining draft mock
packages/telemetry/   Early SDK startup, private spans, bounded metrics and trace propagation
tests/                Jest unit/contract/integration, Playwright and k6 checks
infra/                Local dependencies, image/deployment configuration and observability
docs/                 Architecture, operations, verification evidence
.github/workflows/    Contract drift, validation, build and integration CI
```

The [architecture guide](docs/architecture/README.md) describes ownership and planned tenant boundaries. The [local operations guide](docs/operations/local-development.md) covers configuration, health semantics, outages and recovery. [Milestone verification](docs/verification/milestone-01.md) records actual checks and limits.

Milestone 03 adds the complete Drizzle models, tenant RLS/runtime grants, pgvector storage and exact scoped retrieval, atomic document publication/deletion, deterministic fixtures and upgrade/rollback tests. See [database operations](docs/operations/database.md), the [persistence decision](docs/architecture/decisions/0004-persistence-and-tenant-retrieval.md) and [milestone 03 verification](docs/verification/milestone-03.md). Milestone 04 adds the real document worker, checkpoints, four-attempt retry budget, global concurrency/provider limits, 1,000-run admission control and durable DLQ/replay. See [ingestion and recovery](docs/operations/ingestion-recovery.md), the [handoff decision](docs/architecture/decisions/0005-durable-ingestion-handoff.md) and [milestone 04 verification](docs/verification/milestone-04.md). The explicit 64-dimensional embedding model remains synthetic. Hybrid lexical retrieval complements its pgvector channel; production semantic embedding quality is not established by the synthetic provider.

Milestone 05 adds NestJS testing utilities, isolated PostgreSQL/Redis/MinIO Testcontainers, explicit provider status and transaction failure injection, and coverage gates. See the [verification decision](docs/architecture/decisions/0006-isolated-verification.md) and [milestone 05 evidence](docs/verification/milestone-05.md).

Milestone 06 adds tenant-filtered RAG, optional lexical reranking, bounded context, validated source quotations, rendered references, token/cost accounting, prompt versions, asynchronous draft processing and human approval gates. Run `pnpm ai:eval` (or `pnpm ai:benchmark`) for the fixed 60-case synthetic suite at ten concurrent database-backed requests. The combined integration suite also measures ten concurrent authenticated HTTP draft jobs. See [AI drafting operations](docs/operations/ai-drafting.md), [decision 0007](docs/architecture/decisions/0007-evidence-bound-drafting.md) and [milestone 06 results](docs/verification/milestone-06.md). Mock results do not establish live-model quality, latency or cost.

Milestone 07 adds read-only PR/merge-queue verification and protected-main/version-tag GHCR delivery, with separate non-root production images and digest-based promotion. Run `pnpm ci:workflows`, `pnpm security:scan`, `pnpm docker:build` and `pnpm docker:smoke`. See [release/deployment/rollback operations](docs/operations/releases.md), the [branch protection checklist](docs/operations/branch-protection.md), [decision 0008](docs/architecture/decisions/0008-ci-and-image-delivery.md) and [milestone 07 verification](docs/verification/milestone-07.md). Repository protection and registry permissions must be configured before enabling releases.

Milestone 08 adds early OpenTelemetry SDK initialization, private HTTP/GraphQL/SQL/Redis traces, durable request-to-worker context propagation, ingestion/RAG spans, token/cost and queue metrics, and provisioned Grafana/Tempo/Prometheus with tested alerts. Run `pnpm observability:up`, set `OTEL_ENABLED=true` in `.env`, then restart the apps. Grafana runs on http://127.0.0.1:3003; its private generated password is in ignored `.env.observability`. `pnpm observability:check` validates configuration and alert firing; `pnpm observability:verify` checks the running services and authenticated provisioning. `pnpm perf:run` measures isolated k6 drafting and queue saturation with mock providers. See [operations/recovery](docs/operations/observability.md), [performance measurements and limits](docs/performance-report.md), [decision 0009](docs/architecture/decisions/0009-private-operational-telemetry.md) and [milestone 08 verification](docs/verification/milestone-08.md).
