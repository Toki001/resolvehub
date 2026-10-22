# Milestone 10 — Model access and guarded selection

2026-10-22, macOS/arm64, Node 22.22.3 and pnpm 12.10.1. Baseline `8c0d226`. Automated regression verification is separate from the **blocked full live RAG acceptance check**. No billing/account changes, paid model/feature, provider fallback, remote deployment or image push occurred.

## Access diagnosis

One official `@google/genai` 2.30.0 `models.list` request to `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000` returned HTTP 200 and all 63 models without another page. It listed all three investigated canonical identifiers: `models/gemini-2.5-flash-lite`, `models/gemini-3.5-flash-lite` and `models/gemini-3.1-flash-lite`, each with `generateContent`, 1,048,576 input and 65,536 output token limits. These are provider capacities, not application allowances or remaining free quota.

Google's [pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) lists free standard input/output tokens for the selected **gemini-3.5-flash-lite**. The user's previously recorded project/key Free Tier, billing-disabled and synthetic-scope assertion remained current; its timestamp was preserved. A new explicit model assertion binds that authorization to this exact model. The API key was never printed or committed. No billing audit can be inferred from successful discovery or generation.

The [models reference](https://ai.google.dev/api/models) confirms v1beta and canonical `models/` naming; the existing SDK request route matched Google's [generation endpoint](https://ai.google.dev/api/generate-content). The same API/key successfully generated minimal text with 3.5. Thus no evidence establishes an incorrect version or spelling as the old 404 cause. Google's [2.5 page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite) documents restricted legacy access. That is consistent with the prior failure, but metadata listing cannot prove precise project entitlement. No further 2.5 generation was attempted. 3.1 was investigated through discovery/pricing only; it was never selected or invoked.

## Implementation and preservation

The exact generation model, server status, telemetry allowlist, environment/deployment examples, manual verification command and mocks now use 3.5 Flash-Lite. Missing/mismatched model assertions fail closed. Old model success cannot claim new health; old configuration pauses are model-scoped while project request budgets, leases and quota stops remain shared. API rejects a heartbeat for a different model. New errors distinguish rejected request configuration from invalid provider responses. All 404/configuration failures remain non-retryable; provider timeouts/transient failures remain bounded and 429 stops live generation.

The adapter uses the documented minimal standard text request with bounded output and no SDK retry, continuation, removed sampling/candidate parameters or optional structured-format fields. Prompts request JSON; the application accepts direct JSON or one complete fenced JSON block, then applies existing strict schema, tenant, exact-quotation and citation validation. No model output bypasses human approval. The progress display no longer incorrectly claims four attempts for Gemini's two-attempt bound.

No SQL migration, vector rebuild, embedding change, seed/reset or deletion ran against the local workspace. Existing tickets, documents, saved drafts, review decisions and internal messages remain. The explicit live demo added one labeled synthetic policy, one ticket and failed/replay job records. No live approved reply was produced. Cloud calls used synthetic content only. Offline providers remain available by explicit configuration. Free Tier data may improve Google's products; infrastructure costs are separate.

## Live measurements and blocker

Eight bounded generation attempts ran this milestone. One minimal official SDK request succeeded: **HTTP 200, 1281.96 ms, 5 input tokens, 2 output tokens, 0 reported thinking tokens**, returned model `gemini-3.5-flash-lite`. Estimated API cost under the manually verified Free Tier pricing is $0; no invoice or infrastructure cost was measured.

Optional structured configurations returned HTTP 400/INVALID_ARGUMENT. Diagnostics identified the singular `responseFormat` field and MIME enum requirement; the final adapter uses the already successful standard text configuration and local validation instead. Synthetic worker attempts still failed after one attempt with `GEMINI_UNAVAILABLE`. Their exact HTTP/body evidence was not retained by the previous adapter, so the report does not invent a precise root cause. A verification script also initially used `id` rather than the accepted receipt's `jobId`; polling was corrected without submitting an automatic duplicate generation.

The final persistent project ledger reached **10 requests in its rolling day**, including two milestone-09 requests. Failed/time-out requests remain counted. No ledger/quota reset, limit increase, automatic model change or further inference occurred. The current dashboard must stay Unavailable because admission is blocked. This is the **application limit**, not a measured Google quota-exhaustion response.

**Not established live:** a completed RAG answer, correct citations, abstention quality, draft token/latency measurements, live edit/approval/persistence and a healthy full-workflow indicator. The one text success is not a passing support-workflow benchmark. Further live diagnosis requires an available rolling budget and current manual model-bound verification; billing must remain disabled. Timeout, invalid-model, quota, recovery, citation integrity and full internal support workflows are verified with mocks below.

## Regression checks

| Command                                   | Measured result                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`          | Passed for all 9 workspaces; no dependency version change.                                                                                                                                     |
| `pnpm check`                              | Formatting, ESLint, strict TypeScript, 18 REST operations, GraphQL validation and unit/contract tests passed.                                                                                  |
| `pnpm test:coverage`                      | **341 tests / 36 suites**, all baseline tests retained; **92.56% branch coverage**, unchanged independent 80% critical-area gates passed. Disposable Testcontainers; no cloud calls.           |
| `pnpm test:dashboard`                     | Production build and **14 desktop/mobile checks** passed, including persisted internal replies, editing/approval/rejection, tenant switching and provider outage status.                       |
| `pnpm docker:build` / `pnpm docker:smoke` | All three arm64 images built; non-root/read-only/secret mounts, health/readiness, clean/repeat migrations, REST/GraphQL, assets, BullMQ/duplicate probe and graceful shutdown passed. No push. |
| `pnpm audit --prod --json`                | Zero runtime advisories.                                                                                                                                                                       |
| `pnpm infra:check`                        | Compose syntax passed; no deployment.                                                                                                                                                          |
| `pnpm ci:workflows`                       | Actionlint and SHA-pin policy passed.                                                                                                                                                          |
| `pnpm security:scan`                      | No blocked advisories; existing development-only exception expires 2026-11-21.                                                                                                                 |

Critical branch figures: AI Gemini 92.25%, API application 94.73%, worker drafting 89.68%, DB repositories 88.77%. New tests cover model-bound verification, discovery methods/pagination/error redaction, no inferred quota, cross-model status/budget preservation, invalid configuration, fenced JSON/prose rejection, and existing timeout/429/404/recovery behavior.

The unchanged 60-case **offline mock** evaluation ran during coverage against PostgreSQL/pgvector at concurrency 10: Recall@5 30/30, supported claims 30/30, correct abstention 30/30, tenant leakage 0/60. Pipeline p95 **27.93 ms**, maximum 30.41 ms, excluding queue delay. These results do not establish Gemini quality or production latency. Exact denominators/intervals and unknown live metrics are in [metrics](milestone-10-metrics.json).

Initial formatting warnings and local tsx IPC sandbox restrictions were resolved before passing checks. Raw private logs/artifacts and credentials remain ignored. See [operations/reproduction](../operations/gemini-free-tier.md) and [decision 0012](../architecture/decisions/0012-gemini-model-access.md).

The final local restart exposed a changed private `AI_PROVIDER` setting that prevented worker startup. Restored only that ingestion/embedding setting to `mock`, preserving `DRAFT_PROVIDER=gemini`, the selected model, current key verification, secrets and all records. The optional production Gemini Compose overlay also passed syntax validation with placeholder metadata only.

After restoration, API and worker readiness returned HTTP 200. Authenticated status reported the selected 3.5 model, current manual Free Tier verification, `Unavailable`, `canGenerate=false` and `GEMINI_DAILY_LIMIT`, with no new cloud requests. Final generated-client drift, formatting, whitespace and staged/browser-asset secret checks passed.
