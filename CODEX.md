# ResolveHub — Codex Project Specification

> Status: implementation blueprint, not a claim that features are built or verified.  
> Project: **ResolveHub**, multi-tenant AI-assisted customer support operations.  
> Primary implementation language: **TypeScript**.  
> **Codex:** read this entire file and the repository's `AGENTS.md` before making changes. Follow the current milestone in the user's prompt; do not implement future milestones prematurely.

## 1. Product definition

Build a genuinely usable B2B customer-support operations platform. Organizations manage tickets and knowledge documents. Ingestion indexes approved document versions. An evidence-grounded AI assistant **drafts** responses to tickets, showing exactly which passages support each claim. A human agent edits/approves a draft before a reply can be sent. This is **not** a generic chatbot or a static dashboard mockup.

### User roles and flows

- **Organization admin**: manage organization configuration, invite/team roles, document sources, retention settings and quotas.
- **Support agent**: inspect/search tickets, attach documents, request grounded draft, edit and approve/reject drafts, update ticket state.
- **Read-only analyst**: view permitted tickets and summary metrics, never modify data.
- **Core flow A**: upload knowledge document → asynchronous parse/chunk/embed/index → publish verified index version → searchable knowledge article.
- **Core flow B**: incoming ticket via dashboard or signed webhook → filter tenant-safe knowledge → create draft with verifiable citations → human approves before sending.
- **Core flow C**: malformed upload or provider outage → job retries or terminal failure → operator sees state and can safely replay.

### Out of scope initially

No autonomous customer messaging; no payment/billing integration; no omnichannel proprietary CRM integrations beyond an adapter and a documented webhook; no real customer data in demo; no invented confidence percentages; no microservices beyond the declared services merely for appearance.

## 2. Mandatory stack and project layout

- **Monorepo**: pnpm workspaces + Turborepo; pinned lockfile, strict TypeScript, ESLint, Prettier.
- **UI**: Next.js App Router, React, Tailwind, accessible keyboard-friendly components.
- **API**: NestJS, REST OpenAPI 3.1 plus schema-first GraphQL (select an appropriate NestJS GraphQL adapter and document choice).
- **Persistence**: PostgreSQL, Drizzle ORM, SQL migrations, `pgvector`; strict tenant access controls.
- **Async**: Redis + BullMQ worker, explicit durable application DLQ; object storage: MinIO (S3-compatible).
- **AI**: configurable LLM and embedding adapters; mocked provider for CI; exact model/embedding dimensions loaded from configuration, not guessed.
- **Testing**: Jest, Testcontainers for database and Redis, contract tests, k6 for benchmarks.
- **Operations**: Docker Compose local, GitHub Actions, GHCR, OpenTelemetry Collector, Grafana + Tempo + Prometheus.

```text
resolvehub/
├── AGENTS.md                     # Automatically loaded Codex repo instructions
├── codex.md                      # This full project specification
├── apps/web/
├── services/api/src/{auth,rest,graphql,tickets,knowledge,review,webhooks}/
├── services/worker/src/{ingestion,drafting,dlq}/
├── packages/contracts/{openapi.yaml,schema.graphql}/
├── packages/generated/
├── packages/db/{schema,migrations,seeds}/
├── packages/ai/{providers,prompts,retrieval,evals}/
├── tests/{unit,integration,contract,load}/
├── infra/{otel,grafana,docker}/
├── docs/{architecture,operations,verification}/
├── .github/workflows/
├── docker-compose.yml
├── pnpm-workspace.yaml
└── turbo.json
```

Keep domain business logic out of React views and transport controllers. Isolate auth, ticket service, index publication, retrieval, draft generation, and worker adapters behind typed service interfaces. Share runtime schemas where practical; do not copy-and-paste incompatible DTOs.

## 3. Functional acceptance criteria

1. Real session-based or token-based auth, securely stored, and server-derived organization context; tenant ID in a request is **never** sufficient authorization.
2. CRUD for tickets, messages and versioned knowledge documents; ticket status transitions are validated.
3. Ticket list and knowledge list have working cursor pagination, filtering, stable sort, bounded page sizes and useful empty/error states.
4. Document processing has statuses `uploaded`, `queued`, `processing`, `indexed`, `failed`, `superseded`; clients can poll real job status.
5. Only published, currently authorized document versions are retrieved. A new indexing failure never removes the prior active index.
6. Drafts include text, source document/version/chunk IDs, rendered references, prompt/model version and usage/cost metadata.
7. Citation validation rejects fabricated/unknown chunk IDs and blocks unsupported AI output from being treated as approved.
8. A draft cannot become an outbound reply without a human approval action, audited with actor and timestamp.
9. All externally invoked mutations are idempotent where applicable, including webhook receipt, document indexing and draft approval.
10. A visible operations section exposes failed tasks, reason codes, attempts, and an admin-authorized replay action.

## 4. Contracts: REST, GraphQL, errors

- Canonical REST contract `packages/contracts/openapi.yaml` (OpenAPI 3.1). Generate client via `openapi-typescript` + `openapi-fetch`.
- Canonical GraphQL SDL `packages/contracts/schema.graphql`; generate typed document operations with GraphQL Code Generator.
- REST examples: `POST /v1/documents/uploads`, `POST /v1/documents/{id}/index`, `GET /v1/jobs/{id}`, `POST /v1/tickets`, `POST /v1/tickets/{id}/drafts`, `POST /v1/drafts/{id}/approve`, `POST /v1/webhooks/tickets`, `POST /v1/jobs/{id}/replay`.
- GraphQL queries: `tickets(first,after,filter)`, `ticket(id)`, `knowledgeDocuments(first,after)`, `knowledgeSearch(query)`, `draft(id)`, `dashboardSummary`.
- Errors: typed `{code,message,requestId,details?}`; use 400 for invalid input, 401/403 auth, 404 for unauthorized resource non-disclosure where appropriate, 409 for state/idempotency conflict, 422 invalid content, 429 for capacity, 503 for dependency failures.
- Use `202 Accepted` plus job ID for asynchronous operations; cap page size (e.g. 100); opaque cursors tied to stable sort fields and tenant filters.
- Signed inbound webhooks: verify signature, timestamp tolerance, event idempotency and payload size **before** mutation.
- Contract drift is a test failure; never hand-edit generated clients.

## 5. Data design and evolution

Core tables: `organizations`, `memberships`, `customers`, `tickets`, `ticket_messages`, `knowledge_documents`, `document_versions`, `knowledge_chunks`, `draft_responses`, `citations`, `audit_events`, `idempotency_records`, `job_runs`, `failed_jobs`.

- `organization_id` present wherever isolation applies, with composite tenant-aware unique keys and indexes. Tenant filtering must occur in **every** read, retrieval and mutation path.
- Document version ID and chunk ID are immutable evidence identifiers. Attach content hash and embedding model version. A transactional `active_version_id` pointer controls publication.
- Store embedding vectors using dimension set by the actual embedding model; migrations must explicitly reflect dimension/model changes. Scope vector retrieval to tenant and active document versions.
- Use transactions for draft approval, index publication and audit state changes. Record immutable approval/audit history.
- Add real numbered migrations and verify clean install, repeated apply, and at least one forward-compatible **expand → migrate → contract** change. Avoid destructive migration on active data without documented backup and recovery.
- Deterministic synthetic seed: 2 orgs, 100 documents, 200 tickets, duplicate-looking questions, misleading documents, revisions and failed jobs. No real data.

## 6. Worker and failure semantics

- **One concrete job**: `indexDocument(documentId,versionId)` downloads object, validates MIME/size/hash, parses, chunks, embeds, stages DB rows, then atomically publishes index version.
- **At-least-once delivery**: duplicates must be harmless via unique keys, run lease/lock and version checks. Do not claim exactly-once execution.
- Worker concurrency is bounded; per-provider rate limits apply. Admission target: 1,000 waiting ingestion documents before rejecting new submissions with 429/Retry-After.
- Transient failures retry for **4 total attempts** with exponential backoff and jitter; invalid/oversize files are terminal immediately. Respect provider Retry-After.
- On terminal failure, create a durable `failed_jobs` entry with structured reason, attempts, last error summary, trace ID, input fingerprint and replay eligibility; never store secrets in error traces.
- Recover from Redis outage and DB failures; do not lose the previous published index. Track queue age, throughput and DLQ count. Operators can replay with scoped auth; replays remain idempotent.

## 7. AI contract, guardrails and evaluation

Pipeline: tenant-scoped query embedding → vector retrieval (top-k) → optional rerank → context selection with strict token budget → evidence-grounded generation → citation allowlist check → structured draft output → review.

- LLM output is untrusted. Treat document text as retrieved content, never instructions. Never pass another organization's content to the model.
- If no sufficient evidence exists, return explicit **insufficient evidence** and optionally request human clarification; do not fabricate a cited answer.
- Version prompts and models. Record separately retrieval latency, generation latency, input/output token counts, per-token provider pricing assumption, computed variable cost, and UTC time.
- Golden file: `packages/ai/evals/golden.jsonl` with **60 synthetic cases**: 30 answerable, 20 intentionally unanswerable, 10 adversarial/cross-tenant. Include expected evidence IDs and banned content checks.
- Metrics (with denominators reported): Recall@5 ≥90%; factual claim citation support ≥95%; correct abstention ≥95%; **zero** cross-tenant content leaks; p95 ≤6 seconds at 10 concurrent drafts; variable AI cost ≤$0.02/draft.
- Report split by case type, bootstrap limitations/sample sizes, confidence intervals when sensible, actual model/price date, and failures. These values are **targets**, not claimed results.
- CI eval must be deterministic with mock provider; live provider benchmark may run manually and records its provider/model version and cost.

## 8. Non-functional engineering rules

- Tenant isolation tested at API, DB query and retrieval layers. Validate object storage keys and presigned URLs are tenant-scoped.
- Use timeouts, circuit-breaker or finite failure responses for provider calls; no infinite polling, infinite retries or unbounded fanout.
- Request limits and payload sizes are enforced; upload source types allowlisted; extracted text sanitized for output.
- Authentication, authorization, input validation, CORS, webhook replay protection, SSRF prevention on external fetches, secret management and dependency checks are required.
- System behavior during partial outages must be documented. Where a network read fails, display explicit retriable error rather than a deceptive success state.
- UI responsive and accessible; all actionable buttons connected to persisted domain operations (or visibly disabled with rationale).
- No unreviewed code execution from prompt content; no misleading fake demo data in production mode.

## 9. Test matrix

- **Unit/Jest:** tenant guards, ticket state machine, citation verifier, chunking, cursors, idempotency.
- **Integration/Testcontainers:** PostgreSQL migrations, Redis jobs, webhooks, authenticated REST/GraphQL, search isolation, approval transaction.
- **Failure injection:** embedding 429/500/timeouts, Redis disconnect, worker process crash, duplicate job, partial index write, DB rollback, unauthorized DLQ replay.
- **Contract:** OpenAPI and GraphQL generation drift; status/error schemas.
- **Benchmark:** k6 concurrent drafts and ingestion saturation; label environment, data volume, provider mode.
- Targets: ≥80% branch coverage of critical services; all integrity and isolation tests passing. Report measured coverage; do not claim it before testing.

## 10. CI/CD and telemetry

- PR workflow: lockfile install, format/lint, typecheck, client generation drift check, unit/contract/integration tests, migration check, security checks, Docker build smoke test.
- Main/tag release: separate non-root multi-stage images for web/API/worker; immutable tags pushed to GHCR; SHA-pinned third-party Actions; minimum permissions; never expose publish secrets to fork PRs.
- Migration step before traffic cutover, backward-compatible rollout order and rollback runbook.
- OpenTelemetry initialized at process startup. Trace HTTP → API → Redis queue → worker → PostgreSQL/MinIO → embedding/LLM; propagate W3C context where supported.
- Observe p50/p95/p99, error rate, queue depth/age, retry/DLQ rates, index throughput, retrieval latency, generation latency, tokens/cost per draft and rejected cross-tenant attempts.
- Local stack: OTel Collector, Grafana, Tempo and Prometheus; redact ticket bodies, keys, customer identifiers and token payloads from telemetry.

## 11. Eight sequential Codex milestones

Only advance when the current milestone is verified. Each milestone ends with a commit and a concise report: changed files, commands actually executed, results, unresolved issues and next steps.

1. **Scaffolding** — repo layout, dependencies, Docker Compose, environment validation, UI shell, health endpoints, this specification and `AGENTS.md`.
2. **Contracts** — OpenAPI + GraphQL SDL, working handlers, typed generated clients, pagination/idempotency/auth, contract tests.
3. **Data** — complete Drizzle schema, migrations, fixtures/seeds, tenant isolation, document publication.
4. **Workers** — real indexing job, concurrency/admission control, retries, durable DLQ, replay and partial-failure tests.
5. **Tests** — Jest unit/integration/contracts, Testcontainers, failure injection, coverage gates.
6. **AI** — retrieved evidence + citations + review, evaluation harness + 60-case golden set, measured quality/latency/cost report.
7. **CI/CD** — hardened Dockerfiles, GitHub Actions and GHCR, migration/rollback docs, verified workflow checks.
8. **Instrumentation** — OTel trace propagation, Grafana dashboards, alerts, k6 benchmark and factual performance report.

### Definition of done for each milestone

- No placeholders masquerading as working features; no unused dead code or demo controls in release UI.
- Relevant format/lint/typecheck/test/build/migration commands run successfully, or blockers shown accurately.
- Modified behavior covered by tests; documentation and generated clients aligned with source.
- Commit message format: `milestone(N): <short description>` (use a meaningful conventional message if existing repo already follows another standard).
- Working tree clean after milestone if possible; **do not commit unrelated user changes**.
- Do not silently change planned architecture, performance targets or security boundaries. Record justified deviations in `docs/architecture/decisions/`.

## 12. Demo and handoff

Deliver README with setup and screenshots, credentials for **synthetic demo users only**, OpenAPI docs, GraphQL explorer, an architecture diagram, evaluation table with actual runs, production-style runbooks and incident recovery scenario. Demo two organizations, one approved cited response, an abstention, cross-tenant rejection, and failed document reindex that preserves the previous active index. Distinguish real benchmarks from aspirational goals.

## 13. Codex kickoff prompt

> Read `AGENTS.md` and `codex.md` completely. Inspect the existing repo. Implement **milestone 1 only** for ResolveHub. Keep the full project scope and acceptance tests in mind but do not implement later milestones yet. Run the relevant checks, document evidence, and commit as `milestone(1): scaffold ResolveHub`. Report any unverified work honestly.
