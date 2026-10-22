# Milestone 09 — Free Tier Gemini verification

Verified 2026-10-21–22 (Asia/Manila) on macOS/arm64, Node 22.22.3, pnpm 12.10.1 and Docker. Baseline: `beb528a`. No remote publication/deployment, billing setup or account upgrade occurred.

## Delivered

Official pinned `@google/genai` adapter for exactly `gemini-2.5-flash-lite`: fixed HTTPS standard text/JSON endpoint, no tools/paid features, no SDK retry or automatic continuation, bounded input/output/deadline/response size, reported usage and runtime citation validation. A current manual Free Tier/billing-disabled assertion must match project, key digest and approved synthetic organization scope before each cloud call.

Project-wide Redis rolling budgets and concurrency leases fail closed during disconnection. Provider 429 stops the job after one attempt, persists a pause and creates a replayable PostgreSQL DLQ record. Transient errors allow at most two application attempts with backoff/Retry-After. Authenticated status and admission show Synthetic, Gemini Live or Unavailable; Live requires observed success for the verified key. Existing edits, human approval/rejection and persisted internal-only messages remain.

Embedding free quota was not confirmed. No vector migration/reindex ran; the existing synthetic/64 profile, tenant filters, publication rules and previous-index failure preservation remain intact. No semantic Gemini embedding quality is claimed.

## Commands and measured results

| Command                                   | Actual result                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`          | Passed. SDK pinned; unnecessary lifecycle scripts explicitly disabled after the initial installation policy failure.                                                                                                |
| `pnpm check`                              | Format, ESLint, strict workspace/test types, 18 REST operations/controller compatibility, GraphQL validation and 224 unit/contract tests in 23 suites passed.                                                       |
| `pnpm test:coverage`                      | 327 tests in 35 suites passed, retaining all 289 baseline tests. Aggregate branch coverage 92.49%; all independent 80% critical-area gates passed unchanged. Disposable PostgreSQL/Redis/MinIO; cloud calls mocked. |
| `pnpm test:dashboard`                     | Production build and 14 desktop/mobile checks passed, including persisted internal-only messages, full support workflows, tenant switching, sign-out, polling recovery and provider outage status.                  |
| `pnpm docker:build` / `pnpm docker:smoke` | Three arm64 images built; non-root/read-only/secret mounts, health/readiness, clean/repeat migrations, REST/GraphQL, web assets, BullMQ/duplicate probe and graceful shutdown passed. No push.                      |
| `pnpm ci:workflows`                       | actionlint and SHA-pin policy passed.                                                                                                                                                                               |
| `pnpm security:scan`                      | No blocked advisories; existing development-only exception expires 2026-11-21.                                                                                                                                      |
| `pnpm audit --prod --json`                | Zero production dependency advisories.                                                                                                                                                                              |
| Compose with `gemini-free.override.yaml`  | Syntax passed with placeholder verification values; no deployment. Gemini secret is worker-only.                                                                                                                    |
| `pnpm ai:gemini:verify ...`               | Recorded the user's manual Free Tier/billing-disabled assertion privately, bound to the key and synthetic workspace. No Google/billing request.                                                                     |
| Explicit `pnpm ai:gemini:smoke --live`    | Two bounded attempts across initial and diagnostic runs; diagnostic HTTP 404/NOT_FOUND. No completed draft, fallback or further live inference after identifying the blocker.                                       |

Critical branch coverage: API application 95.13%, authentication 92.59%, DB repositories 88.77%, worker drafting 89.68%; Gemini adapter/configuration directory 90.65%. These figures cover the configured critical services, not every React component.

New tests cover eligibility/expiration/key rotation, synthetic tenant restrictions, token/model limits, continuation suppression, 403/404/429/500/503, timeouts, oversized output, shared concurrency/rolling budgets, Redis disconnection, provider recovery, real scoped PostgreSQL retrieval, fabricated citations/abstention, durable quota DLQ/replay, finite retries, safe status/admission and Retry-After. Early type/lint issues and an overly narrow legacy key-format assumption were corrected before passing checks; no key was printed.

Restarting also exposed missing/changed private local settings. Setup restored the missing API signing secret and existing synthetic embedding configuration, reprovisioned only the reserved local sign-in, and preserved the Gemini key/project/model. No customer records or published indexes were replaced.

The restarted local API and worker both reported dependency readiness. A real headless browser signed into the reserved workspace, confirmed authenticated status `GEMINI_MODEL_UNAVAILABLE` with generation disabled, and signed out; the subsequent status request returned 401. This runtime check made no cloud calls. Final formatting, generated-client drift and staged secret checks passed before the commit.

## AI measurements and remaining blocker

The unchanged 60-case **offline mock** evaluation measured Recall@5 30/30, supported citations 30/30, correct abstention 30/30 and tenant leakage 0/60. Pipeline p95 was 32.39 ms, excluding queue delay. Mock token estimates: 6500 input, 1699 output, 542 embedding; estimated mock variable API cost $0. Exact denominators/intervals are in [metrics](milestone-09-metrics.json). These synthetic results do not establish Gemini quality or a production SLA.

Live Gemini returned no successful draft or usage metadata: live citation accuracy, abstention, token usage and generation latency are **not available**. No cloud benchmark/cost target is claimed. The diagnostic returned HTTP 404/NOT_FOUND for the exact requested model. Google's [model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite) restricts 2.5 access to previous users, which may explain project availability; precise entitlement remains external. The measured failure is retained as Unavailable. Free access to this exact model, or explicit authorization of a separately verified model change, is needed; billing must remain disabled.

See [operations/privacy/recovery](../operations/gemini-free-tier.md) and [decision 0011](../architecture/decisions/0011-free-tier-gemini.md). Credentials, raw live logs and private test artifacts remain ignored.
