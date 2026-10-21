# Milestone 06 verification

Verified locally on 2026-10-21, Node 22.22.3 / pnpm 12.10.1, Apple M3 Pro / Darwin arm64, Docker PostgreSQL 17/pgvector, Redis 7.4 and MinIO. Results below use **the deterministic extractive mock and hybrid lexical/vector retrieval**. No paid LLM calls, real customer records or live Ollama model runs were used. GitHub Actions has not been run remotely.

The complete suite passed **238 tests in 26 Jest suites**: 154 unit/contract and 84 integration checks. All six desktop/mobile browser checks passed against the final compiled stack on ports 3100–3102. Separate readiness and smoke checks passed, including an actual BullMQ probe. The existing development stack and Compose volumes were preserved.

The fixed corpus has 60 tickets: 30 answerable, 20 insufficient-evidence and 10 adversarial/cross-tenant cases, plus 136 corpus versions: 30 current answer passages, 70 current distractors, 30 superseded passages, two private additions, two poisoned additions and two deleted additions. The checked-in JSONL is authoritative. Fixture digest: `01a5a9b8ed414977187300b8ac56fcc62a5c7a87ecb2761ca44b5d4a1bc74eb5`.

| Metric                                     | Measured result                              | Target                      | Interpretation                                                                                         |
| ------------------------------------------ | -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Hybrid Recall@5                            | 30 / 30 = 100%                               | ≥90%                        | After tenant-filtered pgvector/full-text fusion and optional lexical reranking                         |
| Supported emitted claims                   | 30 / 30 = 100%                               | ≥95%                        | Exact source quotation and expected immutable evidence identity; extra unsupported output is penalized |
| Correct abstention                         | 30 / 30 = 100%                               | ≥95%                        | 20 / 20 insufficient cases plus 10 / 10 adversarial cases                                              |
| Tenant/forbidden-source leakage            | 0 / 60 requests                              | 0                           | Checks retrieved/context/cited identifiers, source text and forbidden canaries                         |
| Answerable tickets answered                | 30 / 30                                      | Additional anti-gaming gate | An always-abstaining provider cannot pass                                                              |
| Pipeline p95, concurrency 10               | 28.45 ms, 60 requests / six batches          | ≤6,000 ms                   | Real pgvector/SQL; mock generation; excludes queue delay                                               |
| HTTP/queue/worker/poll p95, concurrency 10 | 618.11 ms, 10 requests, worker concurrency 2 | ≤6,000 ms                   | Includes authenticated submission, queue, RAG and GraphQL polling; excludes ticket fixture creation    |
| Estimated variable AI cost                 | Maximum $0.00 per draft                      | ≤$0.02                      | Explicit zero mock API prices; excludes hosting and unreported charges                                 |
| Raw synthetic vector-only Recall@5         | 2 / 30 = 6.67%                               | No passing semantic claim   | Baseline exposes the limitations of hash embeddings                                                    |

These are observed mock results, not production or live-model quality/cost/SLA claims. Descriptive Wilson 95% intervals for each 30/30 proportion span approximately 88.65%–100%; the 0/60 leakage interval spans 0%–6.02%. Paired synthetic templates are not independent production samples. The [machine-readable measured report](milestone-06-metrics.json) contains category splits, numerators, denominators, intervals, environment and timings. Full per-case outputs are generated in `test-results/ai-evaluation.json` and uploaded by CI.

Coverage includes the newly implemented AI pipeline and worker. Each critical area independently requires at least 80% branches:

| Area                     | Covered / total | Branch coverage |
| ------------------------ | --------------- | --------------- |
| AI adapters and drafting | 170 / 176       | 96.59%          |
| Scoped persistence       | 245 / 273       | 89.74%          |
| API application services | 143 / 149       | 95.97%          |
| API authorization        | 50 / 54         | 92.59%          |
| Draft worker             | 35 / 39         | 89.74%          |
| Ingestion worker         | 177 / 191       | 92.67%          |
| Combined                 | 820 / 882       | **92.97%**      |

Statements/lines: 3,416 / 3,475 (98.30%). Functions: 189 / 195 (96.92%). The PDF thread entrypoint remains included with zero process-local coverage; its real compiled/development extraction behavior tests pass, as documented in milestone 05.

Commands actually run and passed:

- `pnpm install --frozen-lockfile`, `pnpm audit --prod --audit-level high` (no known vulnerabilities reported).
- `pnpm check`: formatting, ESLint, strict workspace/test/script types, OpenAPI 3.1/13 controller operations, GraphQL SDL/client operation validation and 154 unit/contract tests.
- `pnpm typecheck` separately; `pnpm build` for all packages/services and the Next.js production application.
- `pnpm generate`, followed by staged intended generated output and `pnpm contracts:drift`; fresh generation reproduced the intended clients.
- `pnpm ai:eval`: unchanged 60-case evaluation with disposable infrastructure and ten concurrent database-backed requests. `pnpm ai:benchmark` invokes the same benchmark. The full integration run also executed it and generated the measured report above.
- `pnpm test:coverage`: 238 tests and all six critical-area gates. This includes clean/repeated/upgraded/checksum-protected migrations, Faker seed repeatability, RLS/runtime grants, previous ingestion failure tests and the new AI checks.
- `pnpm db:migrate`: applied the tested expand-only 0008–0010 migrations to the existing local database; no seed/reset or volume deletion.
- Compiled `pnpm start` on ports 3100–3102; readiness, `pnpm smoke` and `pnpm test:e2e` with matching origins/URLs.
- `git diff --check`.

New verification covers strict provider output/usage/model validation, bounded streamed responses and timeouts, price arithmetic and cost refusal, prompt/context limits, forged/unknown/cross-tenant citations, unsafe source instructions, malformed query embeddings, optional reranking, empty evidence, exact citation rendering and evaluator negative controls. Real worker tests cover duplicate delivery, delayed claims, four provider failures and durable DLQ replay, interrupted attempts, publication rollback, cumulative known usage and missing-usage flags, stale tickets/evidence/membership, and execution under the restricted nonowner worker role. HTTP tests prove pending human review, scoped approval, abstention rejection, deleted-source rejection and zero automatic agent messages.

The first measured evaluation found two maintenance abstentions and two erroneous answers to cross-tenant questions using merely related own-tenant evidence. It failed support/abstention targets, with no foreign-source leak. Requiring every significant question term in the evidence quotation corrected those cases without editing the golden JSONL. Earlier development runs also caught OpenAPI component/indentation errors, an unqualified pgvector type under a scratch schema, ESM declaration/test typing errors and a shadowed test variable. Corrections passed the complete suite; failures are not presented as passing measurements.

The dashboard's old milestone-01 availability text was corrected to distinguish functioning support integrations from dashboard sign-in/data/review access that remains unwired. No fake action or chat interface was added. Outbound customer delivery is still absent: human approval changes audited review state without sending. A real semantic embedding model requires a new adapter/migration/reindex, and live Ollama quality, latency and cost remain unmeasured. See [AI operations](../operations/ai-drafting.md) and [decision 0007](../architecture/decisions/0007-evidence-bound-drafting.md).
