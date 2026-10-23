# Portfolio deployment preparation

ResolveHub's synthetic internal support workflow passed [live acceptance on October 23, 2026](../verification/live-acceptance-2026-10-23.md), using one Gemini request. A portfolio demo can show upload/index → ticket → grounded draft → exact source citation → edit → human approval → saved Internal only reply. Existing deployment examples, images and release/rollback procedures are ready for a target environment. **No remote environment, domain, certificate, image publication or deployment was provisioned by this verification.**

## Demonstrate the verified workflow

Run the existing local stack with `pnpm dev` and open `http://localhost:3000`. The reserved development workspace contains the approved live synthetic ticket and reply. Inspect it without generating another draft; displaying saved evidence/history does not contact Google. Local development credentials expire and are stored only in ignored mode-0600 files. Never put those credentials in a public repository, screenshot or hosted build.

Live demo generation uses only the exact approved `gemini-3.5-flash-lite` model and official SDK. `AI_PROVIDER=mock` continues selecting the synthetic/64 ingestion/query embedding profile; `DRAFT_PROVIDER=gemini` selects real cloud generation. Existing vector data is preserved; hash embeddings are not semantic Gemini embeddings. The pipeline uses tenant-filtered hybrid retrieval and strict exact quotations. No free quota for `gemini-embedding-2` was confirmed, so no cloud embeddings or reindex migration were introduced.

Keep `GEMINI_REQUESTS_PER_DAY=10`, `GEMINI_REQUESTS_PER_MINUTE=2`, `GEMINI_CONCURRENCY=1` and `GEMINI_MAX_ATTEMPTS=1` for a controlled demo. One request was used in this acceptance; failed/time-out requests also count and do not silently switch models or providers. Live demonstrations must respect the actual project free quota, shared rolling ledger, cooldowns and the existing manually verified 24-hour billing-disabled Free Tier assertion. The current recorded assertion expires October 23 at 6:50 PM Manila; subsequent demonstrations need a fresh manual AI Studio check before renewal. Neither a successful key nor a past HTTP 200 proves current billing or quota.

Use synthetic records exclusively. Google may use Free Tier inputs and outputs to improve its products. Support text, provider keys and session credentials stay out of telemetry and client bundles. Every approved reply remains `delivery_status=internal`. SMTP and outbound webhooks are not configured. Budget, provider and dependency failures must remain visible; do not replace failed generation with a mock success.

## Configure a hosting target before promotion

Use the existing [release and rollback guide](releases.md#example-deployment-and-migration-before-cutover), [internal support operations](internal-support.md#storage-and-deployment) and optional [Gemini Compose overlay](../../infra/deploy/gemini-free.override.yaml).

The target still needs:

- A chosen host and public HTTPS domain, TLS termination and explicit origins. The existing example targets one Linux amd64 Docker host; locally verified images here are arm64. Use the release workflow's target images and review their provenance for the deployment architecture.
- Three immutable web/API/worker image digests from the same reviewed release, replacing the zero placeholders in `infra/deploy/release.env.example`. Do not deploy a partial image set or expose publish credentials to pull requests.
- Persistent PostgreSQL 17/pgvector, Redis with persistence/noeviction, and private MinIO/S3-compatible storage. The current readiness adapter expects MinIO's health URL. Infrastructure hosting costs are separate from free Gemini API access; no infrastructure costs were measured or new paid services selected.
- Least-privilege API/worker database identities, a separate migration identity, scoped storage credentials and worker-only Gemini credentials mounted from an external secret directory. Keep the verified API signing key stable or perform the documented explicit rotation plan. Do not copy development root credentials or environment files into an image.
- Authenticated operator access. Development-only “Open local workspace” access is disabled in production. Provision expiring scoped credentials through the existing administrator workflow; do not publish the local demo token or add public registration as part of deployment.
- Current operator confirmation of Free Tier, billing disabled/unlinked, the exact approved model's free quota and an explicitly authorized synthetic workspace. Keep all paid features, fallbacks and automatic provider switching disabled. The production API and worker must agree on the selected provider; the optional overlay sets both.
- Database backup/restore verification, versioned object retention, Redis persistence, readiness/queue monitoring and a reviewed rollback point. Preserve active indexes, citations, approval/audit records and internal messages across releases.

After those values exist, validate the actual deployment env file with `pnpm deploy:check /absolute/path/release.env` and the guide's Compose command. Run numbered migrations through the release runner before traffic cutover; never seed/reset the live database or apply an initial rollback script to preserve a demo. Verify authenticated reads, health/readiness and the already-approved synthetic conversation before any additional explicitly bounded live generation. Keep customer-facing messaging disabled.

The hosted portfolio demonstration is ready to stage after this target configuration and deployment verification. Acceptance of one synthetic live workflow does not establish production semantic accuracy, availability, a ten-concurrent-request p95 or a cost SLA.
