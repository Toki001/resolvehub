# AI-assisted support drafting

Apply `pnpm db:migrate`, then apply the API and worker grants as the migration administrator using the separate logins described in [database operations](database.md). Restart the API and worker after migrations/shared package changes. Default drafting uses the deterministic extractive mock and makes no model network calls. The authenticated dashboard supports these workflows; generated contract clients remain available. For opt-in Gemini Free Tier configuration, privacy, quotas and measured availability, see [Gemini operations](gemini-free-tier.md).

Stage and index approved source documents through the [ingestion flow](ingestion-recovery.md). `POST /v1/tickets/{id}/drafts` with `{}`, a verified bearer token and `Idempotency-Key` returns 202 and a durable job URL. Poll `GET /v1/jobs/{id}`. On success, `resourceId` identifies the persisted draft; query `draft(id)` with the generated `DraftResponseDocument`. No tenant input is accepted as authorization.

A generated draft includes plain-text `text`, immutable document/version/chunk citations, exact `quote` and rendered `reference` values. Its `generation` contains outcome/abstention reason, model/provider/embedding model, prompt version, input/output/embedding token counts, token-count source, price assumptions/date, estimated cost, retrieval/generation/total latency and UTC generation time. Treat all source/quote/text strings as untrusted display text; never render them as HTML. Legacy draft metadata is null and legacy receipt fields may be absent.

`inputTokens`/`outputTokens` and `estimatedCostUsd` aggregate completed provider-call observations for the job, including attempts whose publication rolled back. `accountedAttempts` counts attempts with an observed usage record (including known zero-cost abstention). `usageIncomplete` marks missing observations from failed attempts. Stage timings describe the final pipeline attempt. Per-attempt model, price and timing details remain in `job_attempts.usage`; queue delay and earlier attempts are separate from `totalLatencyMs`. Embedding tokens are mock estimates and embedding API cost is zero for the implemented synthetic model. These are variable API estimates, excluding hosting, storage, retries with unreported usage and operator time.

Every generated draft starts `pending`. An admin or agent must inspect quotations and call `POST /v1/drafts/{id}/approve` with the current `expectedRevision` and an idempotency key, or reject with a reason. Approval rechecks that each source is still published and contains the quotation. An abstention, stale revision or deleted/superseded source cannot be approved. Approval is audited and now atomically records one internal ticket message through the internal delivery adapter. It does not send anything externally. Pending wording can be edited with revision control; edited drafts require explicit acknowledgement at approval. See [internal support operations](internal-support.md). No outbound transport exists; a later transport must recheck approval and source eligibility immediately before delivery.

## Configuration

| Variable                                                      | Default / meaning                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DRAFT_PROVIDER`                                              | `mock`; optionally `ollama`                                                    |
| `DRAFT_MODEL`                                                 | `resolvehub-extractive-mock-v1`; explicit installed model tag for Ollama       |
| `OLLAMA_BASE_URL`                                             | `http://127.0.0.1:11434`; operator-configured base URL, never request input    |
| `DRAFT_RERANK`                                                | `true`; deterministic lexical reranking; `false` keeps hybrid repository order |
| `DRAFT_REQUESTS_PER_SECOND`                                   | `10`, range 1–100; shared Redis provider/model window                          |
| `DRAFT_TIMEOUT_MS`                                            | `5000`, range 100–30000; bounded whole-pipeline deadline                       |
| `DRAFT_MAX_PROMPT_TOKENS`                                     | `4096`; conservative UTF-8-byte upper-bound selection budget                   |
| `DRAFT_MAX_OUTPUT_TOKENS`                                     | `512`, range 64–1024; requested output bound                                   |
| `DRAFT_INPUT_USD_PER_MILLION`, `DRAFT_OUTPUT_USD_PER_MILLION` | `0` for mock; explicit nonnegative operator assumptions for Ollama             |
| `DRAFT_PRICE_DATE`                                            | `2026-10-21`; date of those assumptions                                        |
| `WORKER_CONCURRENCY`                                          | Existing worker bound, independently applied to the draft queue                |

To use a local model, run an independently managed Ollama server with an installed model supporting structured outputs. Set `DRAFT_PROVIDER=ollama`, its actual `DRAFT_MODEL`, price assumptions and price date explicitly, then restart the worker. A zero API price for local inference excludes hardware/electricity. No live model, download, quality score, price or SLA is verified by the mock benchmark. The existing synthetic embedding model and lexical sufficiency gate still apply; semantic provider migration and broader evaluations are required before production claims.

Prompts live under `packages/ai/prompts/`; the executable prompt/version is exported by the pipeline. Change the version and rerun the unchanged evaluation set when modifying generation/evidence policy. Instruction detection is defense in depth, not a general prompt-injection classifier. Tenant filtering, source identity checks, quotation validation, fixed generation capabilities and mandatory human review are independent boundaries.

## Benchmarks and recovery

```sh
pnpm ai:fixtures       # deterministically regenerates the checked-in synthetic JSONL files
pnpm ai:eval           # isolated PostgreSQL/pgvector, 60 cases, ten concurrent pipeline requests
pnpm ai:benchmark      # same reproducible measured benchmark
pnpm test:coverage     # also ten concurrent authenticated REST → BullMQ → RAG → GraphQL jobs
```

These commands own disposable Testcontainers and do not load `.env` or inherit model credentials. CI forces mock mode. `golden.jsonl` has 30 answerable, 20 insufficient and 10 adversarial/cross-tenant cases. `corpus.jsonl` includes current, superseded, deleted, poisoned, private and distractor passages. Expected IDs and natural-language allowed/forbidden behaviors live only in evaluation data. Providers do not read those files.

Reports: `test-results/ai-evaluation.json`, `test-results/ai-http-benchmark.json` and `coverage/`. Metrics report Recall@5 over expected answer evidence, support over emitted quotations (with unsupported extra output penalized), abstention over the 20 insufficient plus 10 adversarial cases, and leakage over all 60 requests. Category splits and descriptive Wilson intervals are included. Small paired synthetic templates do not establish population-level quality. Pipeline latency excludes queue delay; the separate HTTP benchmark includes submission, queue, worker and polling, excluding ticket fixture setup. Both use ten simultaneous requests; mock pricing is explicitly zero.

Redis/provider/database failures retain durable jobs. Transient failures use four total attempts with bounded exponential jitter and provider Retry-After; permanent authority/evidence changes fail immediately. Exhausted jobs have application DLQ records and scoped attempt history. An authenticated admin can inspect `GET /v1/jobs/{id}/failure` and invoke idempotent `POST /v1/jobs/{id}/replay` when eligible. Revoked requesters, unknown tickets and changed evidence are never silently bypassed. Replays use the authenticated operator's current membership and create a separate draft. See [recovery procedures](ingestion-recovery.md) for Redis and database restoration.
