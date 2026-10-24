# Milestone 12 — branch coverage and failure-path test hardening

Verified on **October 24, 2026**, from baseline commit `8042c56`. This milestone changes tests, a coverage verification command and documentation. It does not change production application behavior, provider/model configuration, request budgets, embedding spaces, migrations, or the Internal only delivery policy. No live Gemini requests were made. Development records and volumes were not used by the integration suites.

## Measured results

| Measure                                                     | Previous report      | Verified updated report               |
| ----------------------------------------------------------- | -------------------- | ------------------------------------- |
| Overall branches within existing critical-service selection | 92.33% (1,216/1,317) | **97.84% (1,361/1,391)**              |
| Uncovered branch ranges                                     | 101                  | 30                                    |
| Lines                                                       | 98.72%               | 99.37%                                |
| Functions                                                   | 97.18%               | 97.59%                                |
| Combined Jest tests                                         | 360                  | **406**, all passing across 38 suites |
| Standalone units/contracts                                  | 240                  | **262**, all passing across 26 suites |
| Desktop/mobile browser checks                               | 16                   | **16**, all passing                   |

V8 discovers additional nested branch ranges when previously untouched functions execute. The denominator grew despite unchanged production files and an unchanged coverage selection. This is a measured **5.51 percentage-point increase**, not an assertion that every monorepo module is now covered at this level.

The actual Jest JSON, HTML and LCOV reports were inspected. The [complete risk audit](milestone-12-coverage-audit.md) enumerates **all 101 original gaps**, grouped by file and risk, and **all 30 remaining gaps** with testability and disposition. [Machine-readable branch evidence](milestone-12-coverage-branches.json) preserves branch IDs, source spans, snippets and risk; [summary metrics](milestone-12-metrics.json) preserves counts and critical-area results. The full local HTML/LCOV/raw reports remain in ignored `coverage/`, as before.

A new `scripts/check-coverage.mjs` enforces **95% on actual overall branch counts**, after Jest succeeds. Jest subtracts files matched by directory-specific threshold groups from its global group; this additional check therefore reads `coverage-summary.json` directly. All six existing independent **80% critical-area branch gates remain unchanged**. Gate tests reject missing/corrupt reports and a 94.99% count even if a report's rounded `pct` says 95. No production code was excluded and no assertions or thresholds were weakened.

## Newly exercised security and failure scenarios

- **Authorization, secrets and idempotency:** forged knowledge actors; cross-tenant document deletion and replay; canonical undefined-payload fingerprint; malformed/tampered/wrong-purpose/wrong-key encrypted secrets; webhook database and decryption failures with sanitized dependency errors. Authentication files now report 100% branches.
- **Persistence and tenant isolation:** missing/ineligible/unfinished/foreign/stale-version replay denial; rollback leaves no replay child or idempotency receipt; unapproved drafts cannot persist an agent message; mismatched audit context is rejected; document deletion remains idempotent; stable continuation pages for knowledge/search/reviews/jobs/history do not repeat rows or expose foreign messages.
- **Real connection failures:** terminated PostgreSQL backends during draft/ingestion session cleanup; failed session setup against an empty schema; discarded connections are replaced, tenant context is clear and advisory locks do not leak. Tests use isolated pools/schema fixtures, not a developer database.
- **RAG and citations:** unrelated quotations inside otherwise relevant evidence abstain; context checkpoint failures stop before generation; generation failures remain distinct from retrieval; deterministic quotation tie-breaking; punctuation-only tenant-scoped retrieval. Evidence validation and the knowledge repository report 100% branches.
- **Gemini failures and free-only admission:** absent response streams/usage/content; transport exception and timeout; cancellation during budget admission; error-body cancellation failure retains HTTP 400/404/429 classification; all requests release leases; explicit conservative limit parsing; wrong-model/malformed heartbeat and corrupted Redis state fail closed; unverified budgets cannot admit; minute saturation is visible. Discovery follows three distinct metadata pages at most, without SDK replacement, fallback generation or live calls.
- **Workers and transactions:** checkpoint trigger failure prevents generation and records a persistence DLQ; unknown adapter failure gets a safe worker category; missing-stage failures retain the prior checkpoint; future claims and pre-cancelled work do not fetch; cancellation after the real embedding commit retains staged rows and blocks publication; **an older revision cannot replace an already-published newer index**; queue-acknowledgement trigger failure rolls back PostgreSQL and recovers through the same deduplicated Redis job. Ingestion processor/session code reports 100% branches.
- **Untrusted input and errors:** unsupported media types; pre-cancelled PDF thread creation; a valid-signature but structurally corrupt PDF fails permanently in the real parser without publication; stored historical timestamps outside the transport contract return a sanitized GraphQL error; omitted/empty/status-only ticket filters retain tenant scope.

Cloud SDK transport is injected only at its external network boundary. RAG evidence validation, quota admission, authorization, SQL transactions and worker policy run as real application code. Failure injection wraps a real committed embedding checkpoint, uses actual PostgreSQL triggers/backend termination, actual Redis and the actual PDF worker; it does not replace the behavior under test with success stubs. Ordinary tests own isolated Testcontainers and use synthetic records and offline providers.

## Remaining gaps and limits

The remaining high-risk-file guards are documented individually. Several depend on conditions impossible under current invariants: missing rows from PostgreSQL aggregates, a missing idempotency row after its transaction-local insert/lock, a nonnumeric result from fixed Redis Lua, missing AJV errors on failed synchronous validation, and more than 256 chunks after a 200,000-character input cap. The Gemini endpoint-denial guard cannot be reached through the constant official SDK configuration without altering SDK internals. These guards remain in production and in coverage counts.

Reachable work remains: retained completed/failed Redis-job cleanup in both runtimes, scheduler overlap short-circuits, generic network/SDK failure during **read-only model discovery**, some active-versus-stored trace selection, non-Gemini status/runtime paths and the default unknown-error backoff. These are not labeled unreachable or reported as tested. Security-sensitive authorization, citation, rollback, retry, quota and index-preservation scenarios are exercised, but coverage is not proof of complete security.

The PDF parser runs in a worker thread outside Jest's V8 collector and remains included at **0%**. Real valid/corrupt PDF tests execute it; its individual page/text/resource-cap branches are not separately instrumented or fully verified. V8 also reports empty `finally` boundary ranges even where explicit release/rollback/cleanup assertions pass. No exclusions or instrumentation tricks hide these limits.

## Commands and outcomes

| Command                          | Actual outcome                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed; all 9 workspaces; no lockfile change                                                                                     |
| `pnpm check`                     | Passed formatting, lint, strict workspace/test types, contracts and 262 units/contracts                                          |
| `pnpm test:coverage`             | **Passed, 406/406 tests, 38/38 suites**, 121.116 seconds; 97.84%; overall 95% and six independent 80% gates pass                 |
| `pnpm test:dashboard`            | Passed all **16** desktop/mobile checks in 29.8 seconds; includes `pnpm build` for web/API/worker/packages                       |
| `pnpm contracts:drift`           | Passed REST/GraphQL regeneration; no generated changes                                                                           |
| `pnpm ci:workflows`              | Passed workflow/action-reference checks                                                                                          |
| `pnpm docker:build`              | Passed all three local production image builds; nothing published                                                                |
| `pnpm docker:smoke`              | Passed clean/repeat migrations, non-root/read-only/secret-mount health, REST/GraphQL/assets, BullMQ duplicate probe and shutdown |
| `git diff --check`               | Passed                                                                                                                           |

Contracts validate **18 REST operations**, OpenAPI 3.1, GraphQL SDL and generated operations. The unchanged integration suite also exercises migrations, upgrade/rollback/repeatability, tenant RLS, the synthetic evaluation set, provider retry/exhaustion, approval persistence and internal delivery. Browser checks cover navigation, keyboard use, dependency errors, cross-tenant switching and the full internal support workflow. Live-model acceptance and performance benchmarks were not rerun or inferred from these offline measurements.

## Failures observed and corrected during this work

The initial new fixtures omitted `WEB_ORIGIN` and a required failed-job ID; these were corrected. Strict typechecking caught a missing explicit `this: IngestionSession` annotation in a real-checkpoint injection wrapper; it was added. A new GraphQL test initially expected the service's internal error text, while the public error boundary intentionally returns `Request could not be completed.`; the test now asserts that actual sanitized contract and verifies private content is absent. No application behavior was changed to satisfy those tests.

A later complete run exposed an existing rolling-budget test using the Node clock to age entries only **1 ms** beyond the daily boundary, while production admission uses Redis `TIME`. It intermittently failed with `GEMINI_DAILY_LIMIT`. The fixture now uses Redis's own clock with a 60-second expiry margin. Production quota logic and limits are unchanged. Model-discovery pagination was strengthened from repeated empty pages (which could exercise SDK rejection) to distinct nonempty pages/tokens and an exact **three transport requests** assertion.

Sandbox-only attempts to run tsx and workflow reference checks failed on local IPC `EPERM` and GitHub DNS restrictions. Authorized reruns outside the sandbox passed. The final complete coverage run is clean; earlier failing reports are not represented as passing results.
