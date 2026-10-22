# Gemini Free Tier operations

Milestone 09 adds official SDK generation for `gemini-2.5-flash-lite`. Synthetic offline generation remains the default. No paid-only model/feature, automatic model/provider switch, billing integration, external delivery or Gemini embedding call is implemented.

## Verify eligibility manually

In [Google AI Studio Projects](https://aistudio.google.com/projects), confirm the key belongs to your project, **Billing Tier is Free**, no billing account is enabled/linked, and the exact model has available free request/token quota. Do not select billing setup, prepay or upgrade. A successful key does not prove Free Tier. The SDK has no free-only billing flag; the application requires a key-bound operator assertion, renewed after 24 hours or key/account changes. If eligibility is unknown, leave Gemini disabled.

The current [model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite) restricts 2.5 access to prior users. The configured project's diagnostic returned 404/NOT_FOUND. Access to the specified model remains a blocker. Enabling billing is not a recovery step; no replacement is automatically selected.

Use only the reserved local synthetic workspace or another explicitly approved synthetic-only organization. [Free Tier terms](https://ai.google.dev/gemini-api/terms) allow Google to use inputs/outputs to improve its products. Do not submit real sensitive, confidential or personal customer data. The organization allowlist cannot automatically detect sensitive text.

## Configure

Put `GEMINI_API_KEY` in ignored backend `.env` or a worker runtime secret. Never paste it into chat, commit it, expose it as `NEXT_PUBLIC_*` or provide it to a build. Standard and newer authorization keys are treated as opaque secrets. After the manual checks:

```sh
pnpm ai:gemini:verify \
  --project YOUR_FREE_PROJECT_ID \
  --organization 60000000-0000-4000-8000-000000000001 \
  --confirm-free-tier --confirm-billing-disabled --confirm-synthetic-only
```

This writes mode-0600 `.env`, selects Gemini/its exact model and records project, key digest, verification time and synthetic scope. It neither prints the key nor contacts Google or changes billing. Restart API and worker. The SDK receives the explicit key and Developer API backend; other Google credential variables cannot select Vertex or an alternative backend.

Defaults: `GEMINI_REQUESTS_PER_MINUTE=2`, `GEMINI_REQUESTS_PER_DAY=10`, `GEMINI_CONCURRENCY=1`, prompt selection at most 4096 UTF-8 bytes, output at most 512 tokens. Set request ceilings below your actual project quota; these defaults are application limits, not a guarantee from Google. A rolling project budget is shared across organizations/replicas. Failed and timed-out calls remain counted. Redis must persist its ledger; never flush it or rotate prefixes to evade limits. Redis disconnection fails closed.

The indicator shows Synthetic, Gemini Live or Unavailable. Live requires an observed success for the verified key. Settings exposes safe status, model, unchanged embedding profile and retry messages without probing Google. Other support records and internal review/history remain available during provider outages. Known provider failures return 503; quota/rate admission returns 429 with Retry-After.

## Recovery

Provider 429 stops a job after one attempt, persists a project-wide pause for at least 24 hours (longer Retry-After wins), and records an authenticated manual-replayable application dead letter. There are no continuously retrying quota jobs. Model/authorization failures also pause conservatively; a 404 requires checking exact model access with Google. Timeouts/5xx allow at most two application attempts with backoff and Retry-After. SDK retries/continuation are disabled. Client cancellation does not prove server execution stopped; unknown token usage is not reported as zero.

Restore the provider/dependency, wait for the recorded cooldown and renew Free Tier verification when necessary. An administrator can replay an eligible job in Settings after API admission allows it. Replays remain scoped, audited and idempotent. Do not erase quota pauses or usage to fabricate recovery. To select offline use explicitly, set `DRAFT_PROVIDER=mock` and `DRAFT_MODEL=resolvehub-extractive-mock-v1`, then restart API/worker. Errors never trigger that choice automatically.

`gemini-embedding-2` project free quota is unconfirmed. The current synthetic/64 profile and all published indexes are unchanged. Incompatible model/dimension configuration is rejected. A future verified semantic profile needs staged versioned reindex validation and atomic cutover preserving the old index.

## Tests and live smoke

`pnpm check`, `pnpm test:coverage`, `pnpm test:dashboard` and the 60-case `pnpm ai:eval` use mocked cloud calls only. The separate live smoke requires both explicit opt-in and `--live`; it is forbidden in CI:

```sh
GEMINI_LIVE_SMOKE_ENABLED=true pnpm ai:gemini:smoke --live
```

It owns disposable PostgreSQL containing checked-in synthetic evidence, uses the approved local organization identity, shares the persistent local Redis quota ledger, and never reads customer records or the developer database. It evaluates three cases (answerable, insufficient, adversarial) with at most **one** cloud request, no retry or alternative model. Private `test-results/gemini-live-smoke.json` reports request count, safe error codes and completed-case denominators, latency/tokens when measured. No completed draft means no invented quality or usage result. Current evidence: two attempts across initial and diagnostic runs, zero completed drafts, diagnostic HTTP 404/NOT_FOUND. No further live inference was attempted after identifying the blocker.

Private metrics include `resolvehub_provider_requests`, `resolvehub_provider_quota_exhausted`, `resolvehub_provider_request_duration_seconds`, existing model token/unknown-usage/cost metrics and generation failure/latency metrics. Fixed allowlisted labels exclude keys, project/tenant IDs and text. Free API estimates exclude database, Redis, storage, compute and hosting costs.

Deployment may explicitly add [the optional Compose overlay](../../infra/deploy/gemini-free.override.yaml), with a worker-only key file and manually verified settings. Keep default deployments synthetic until eligibility is established. Neither web nor API containers need Gemini keys.
