# Gemini Free Tier operations

Milestone 10 explicitly selects official SDK generation for `gemini-3.5-flash-lite`. Synthetic offline generation remains the default. No paid-only model/feature, automatic model/provider switch, billing integration, external delivery or Gemini embedding call is implemented.

## Verify eligibility manually

In [Google AI Studio Projects](https://aistudio.google.com/projects), confirm the key belongs to your project, **Billing Tier is Free**, no billing account is enabled/linked, and the exact model has available free request/token quota. Do not select billing setup, prepay or upgrade. A successful key does not prove Free Tier. The SDK has no free-only billing flag; the application requires a key-bound operator assertion, renewed after 24 hours or key/account changes. If eligibility is unknown, leave Gemini disabled.

Google's [pricing table](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) lists free standard input/output tokens for 3.5 Flash-Lite. Discovery with the configured key listed that exact model and `generateContent`; a minimal SDK request succeeded. Listing alone is not a quota or billing audit. The older 2.5 identifier is also listed despite its previous 404, so discovery cannot prove legacy entitlement. `gemini-3.1-flash-lite` was investigated as a listed candidate but is not enabled. No generation call was made to it.

Use only the reserved local synthetic workspace or another explicitly approved synthetic-only organization. [Free Tier terms](https://ai.google.dev/gemini-api/terms) allow Google to use inputs/outputs to improve its products. Do not submit real sensitive, confidential or personal customer data. The organization allowlist cannot automatically detect sensitive text.

## Configure

Put `GEMINI_API_KEY` in ignored backend `.env` or a worker runtime secret. Never paste it into chat, commit it, expose it as `NEXT_PUBLIC_*` or provide it to a build. Standard and newer authorization keys are treated as opaque secrets. After the manual checks:

```sh
pnpm ai:gemini:verify \
  --project YOUR_FREE_PROJECT_ID \
  --model gemini-3.5-flash-lite \
  --organization 60000000-0000-4000-8000-000000000001 \
  --confirm-free-tier --confirm-billing-disabled --confirm-synthetic-only
```

This writes mode-0600 `.env`, selects Gemini/its exact model and records project, key digest, exact authorized model (`GEMINI_FREE_TIER_MODEL`), verification time and synthetic scope. It neither prints the key nor contacts Google or changes billing. Restart API and worker. The SDK receives the explicit key and Developer API backend; other Google credential variables cannot select Vertex or an alternative backend.

Defaults: `GEMINI_REQUESTS_PER_MINUTE=2`, `GEMINI_REQUESTS_PER_DAY=10`, `GEMINI_CONCURRENCY=1`, prompt selection at most 4096 UTF-8 bytes, output at most 512 tokens. Set request ceilings below your actual project quota; these defaults are application limits, not a guarantee from Google. A rolling project budget is shared across organizations/replicas. Failed and timed-out calls remain counted. Redis must persist its ledger; never flush it or rotate prefixes to evade limits. Redis disconnection fails closed.

The indicator shows Synthetic, Gemini Live or Unavailable. Live requires an observed success for the verified key and selected model, with no active failure or admission limit. Model health/cooldown keys are separate; project-wide request counts, leases and quota pauses are shared and never reset by a model change. Settings exposes safe status, model, unchanged embedding profile and retry messages without probing Google. Other support records and internal review/history remain available during provider outages. Known provider failures return 503; quota/rate admission returns 429 with Retry-After.

## Recovery

Provider 429 stops a job after one attempt, persists a project-wide pause for at least 24 hours (longer Retry-After wins), and records an authenticated manual-replayable application dead letter. There are no continuously retrying quota jobs. Model/authorization/configuration failures also pause conservatively; a 404 requires checking exact model access with Google. Timeouts/5xx allow at most two application attempts with backoff and Retry-After. SDK retries/continuation are disabled. Client cancellation does not prove server execution stopped; unknown token usage is not reported as zero.

Restore the provider/dependency, wait for the recorded cooldown and rolling budget, and renew the explicit model-bound Free Tier verification when necessary. Configuration recovery must never clear project request history or quota pauses. The current integrated live failure remains unresolved; do not claim a successful RAG workflow from the minimal text request alone. An administrator can replay an eligible job in Settings after API admission allows it. Replays remain scoped, audited and idempotent. Do not erase quota pauses or usage to fabricate recovery. To select offline use explicitly, set `DRAFT_PROVIDER=mock` and `DRAFT_MODEL=resolvehub-extractive-mock-v1`, then restart API/worker. Errors never trigger that choice automatically.

`gemini-embedding-2` project free quota is unconfirmed. The current synthetic/64 profile and all published indexes are unchanged. Incompatible model/dimension configuration is rejected. A future verified semantic profile needs staged versioned reindex validation and atomic cutover preserving the old index.

Keep `AI_PROVIDER=mock`: it selects the ingestion embedding adapter, not support generation. Set `DRAFT_PROVIDER=gemini` for the live generation adapter. Putting Gemini in `AI_PROVIDER` prevents worker startup; it does not enable cloud drafting.

## Tests and live smoke

`pnpm check`, `pnpm test:coverage`, `pnpm test:dashboard` and the 60-case `pnpm ai:eval` use mocked cloud calls only. Model discovery is metadata-only, explicitly invoked with `pnpm ai:gemini:models --live`, requires current account verification, and is capped at three pages without SDK retries. It reports safe identifiers/methods only. It cannot select a model or establish billing/free quota.

The separate live smoke requires both explicit opt-in and `--live`; it is forbidden in CI:

```sh
GEMINI_LIVE_SMOKE_ENABLED=true pnpm ai:gemini:smoke --live
```

The RAG smoke owns disposable PostgreSQL containing checked-in synthetic evidence, uses the approved local organization identity, shares the persistent local Redis quota ledger, and never reads customer records or the developer database. It evaluates three cases (answerable, insufficient, adversarial) with at most **one** cloud request, no retry or alternative model. Private `test-results/gemini-live-smoke.json` reports request count, safe error codes and completed-case denominators, latency/tokens when measured. No completed draft means no invented quality or usage result. Milestone 10 evidence is separate from historical milestone 09: one metadata listing and eight bounded generation attempts, including one successful minimal text request (5 input / 2 output tokens, 1281.96 ms). Optional structured-format requests returned 400; the final adapter uses the documented standard text request, demands JSON in its prompt, and validates JSON/citations locally. Synthetic worker attempts still failed with the safe `GEMINI_UNAVAILABLE` category; live citation/review acceptance is not established. The persistent ledger reached its unchanged 10/day application cap including two prior milestone requests. No further cloud calls were made. Do not reset the ledger or raise limits to claim success. See [milestone 10 evidence](../verification/milestone-10.md).

For a tiny adapter check use `GEMINI_LIVE_SMOKE_ENABLED=true pnpm ai:gemini:text-smoke --live`. For a complete reserved-workspace upload/ticket/draft/edit/approval demonstration use `GEMINI_LIVE_SMOKE_ENABLED=true pnpm ai:gemini:workflow-smoke --live`. The latter adds clearly labeled synthetic records, makes exactly one generation action, and verifies persisted `internal` messages. It is not normal CI. A failed live check must not be represented as working.

Private metrics include `resolvehub_provider_requests`, `resolvehub_provider_quota_exhausted`, `resolvehub_provider_request_duration_seconds`, existing model token/unknown-usage/cost metrics and generation failure/latency metrics. Fixed allowlisted labels exclude keys, project/tenant IDs and text. Free API estimates exclude database, Redis, storage, compute and hosting costs.

Deployment may explicitly add [the optional Compose overlay](../../infra/deploy/gemini-free.override.yaml), with a worker-only key file and manually verified settings. Keep default deployments synthetic until eligibility is established. Neither web nor API containers need Gemini keys.
