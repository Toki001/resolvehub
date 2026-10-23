# Releases, deployment and rollback

Milestone 07 delivers verified images to GHCR. Infrastructure promotion is an explicit operator action: no repository secret grants access to a production host, and these workflows do not deploy one. Complete the [repository protection checklist](branch-protection.md) before enabling releases.

## Verification and trust boundaries

`ci.yml` runs for pull requests (including forks), merge queues and reusable workflow calls. Four required jobs install with `pnpm install --frozen-lockfile` and verify:

- Formatting, ESLint, strict workspace/test types, OpenAPI/GraphQL compatibility, regenerated client drift, Jest units/contracts and the production build.
- Real PostgreSQL/pgvector, Redis and MinIO through isolated Testcontainers; clean migrations, initial rollback, expansion, checksum corruption, repeat application, deterministic seed replacement, worker failure injection and independent 80% branch coverage gates. Mock AI makes no paid provider calls. Reports are retained for 14 days.
- All locked production and development dependencies against the registry advisory API. Unavailable/malformed audit data fails closed. High/critical findings block unless the exact temporary development-only exception below applies.
- Three Docker production targets, then actual images running with read-only roots, secret files, dropped capabilities and separate API/worker database logins. Smoke checks include image migrations/grants twice, health/readiness, dashboard assets, authenticated REST/GraphQL, a real BullMQ worker roundtrip and graceful worker shutdown.

`Required checks` fails if any prerequisite fails, is cancelled or is skipped. No paths filters bypass it. `pull_request_target`, self-hosted runners, registry logins, publishing permissions, inherited secrets and PR image pushes are absent. Do not add privileged workflows that execute PR-produced artifacts. Dependency lifecycle code runs only on disposable hosted runners with a read-only repository token. Checkout does not persist credentials; package-manager auto caching is disabled.

`release.yml` runs only on pushes to main or `v*` tags. It calls the complete verification workflow for that exact commit. Its read-only authorization job checks GitHub's protected-main flag, checkout SHA and main ancestry, accepting only main or stable `vMAJOR.MINOR.PATCH` tags. Unsupported tags fail closed. The publication matrix then builds `web`, `api` and `worker` for **linux/amd64** in the `ghcr-production` environment. Only that job receives `contents: read` and `packages: write`; login uses `github.token` (the job's `GITHUB_TOKEN`). There are no PAT, OIDC, repository-write or deployment credentials. Arm64 release publishing is not configured; local builds use the host architecture.

Every attempt uses `main-sha-<40-character-SHA>-run-<run-ID>-<attempt>` or `v1.2.3-sha-...-run-...`. Reruns create new references. No mutable latest/main/semver aliases are published. GHCR itself does not make tags write-once: restrict package write access and deploy only `image@sha256:<digest>`. OCI source/revision/version labels and BuildKit minimal provenance identify source without exporting build arguments containing secrets. Each component uploads its digest, tag, revision, migration filenames and verification-run URL in a 90-day release artifact. Promote only when **all three** matrix entries and the workflow succeed; one image publishing does not constitute a release. Archive all manifests in the deployment record beyond artifact expiry.

## Reviewed pins and updates

Official release-tag refs and each action's `action.yml` runtime/entrypoint were inspected on 2026-10-21. All use Node 24 internally on current GitHub-hosted runners; application builds still use `.nvmrc` Node 22.22.3. The following exact commits are pinned in workflows:

| Upstream                                                                                        | Release | Commit                                     |
| ----------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1)                     | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0)                 | v7.1.0  | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)       | v7.0.2  | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| [docker/setup-buildx-action](https://github.com/docker/setup-buildx-action/releases/tag/v4.4.1) | v4.4.1  | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
| [docker/login-action](https://github.com/docker/login-action/releases/tag/v4.6.0)               | v4.6.0  | `dbcb813823bdd20940b903addbd779551569679f` |
| [docker/build-push-action](https://github.com/docker/build-push-action/releases/tag/v7.4.0)     | v7.4.0  | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |

This records pin/runtime review, not an exhaustive audit of bundled upstream dependencies. Update pins in reviewed PRs after checking release notes, commit ownership, action metadata, permission changes and a verification run. `pnpm ci:workflows` downloads [actionlint v1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12), verifies committed SHA-256 checksums before execution, and checks all workflows (including shellcheck when installed). The Node image is pinned to official multi-platform index digest `sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`. Updating Node means reviewing `.nvmrc`, engine bounds, the Docker digest and smoke results together. Existing local MinIO is built from its pinned source release; its Go/Alpine toolchain tags remain a local test infrastructure limitation.

## Dependency exception: expires 2026-11-21

The all-dependency audit uncovered [Faker GHSA-qxc2-j82w-r537](https://github.com/advisories/GHSA-qxc2-j82w-r537); Faker is now pinned to fixed 10.5.0 and fixture repeatability is retested. [Braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no published fix on the verification date. It is a stack-exhaustion issue in deeply nested glob patterns. The only accepted exception is `braces`, high severity, unpatched, every finding marked dev-only, and every path below `packages__generated>@graphql-codegen/cli>`. Code generation consumes repository-controlled configuration on disposable read-only-token runners; production images exclude this closure. Any production path, changed advisory/severity, published fix or expiry blocks CI. The raw report and exception are visible in the artifact and logs. A moderate development `sprintf-js` advisory is reported without blocking the high/critical gate. No blanket pnpm audit ignore setting is used. The maintainer must upgrade/remove the dependency or reassess this documented exception before expiry; changing the gate requires normal security review.

## Runtime security patch verified October 23

The portfolio preflight's dependency scan identified [GHSA-c4qx-w738-7hr3](https://github.com/advisories/GHSA-c4qx-w738-7hr3), affecting the API closure's `@graphql-tools/utils` 12.0.1. A narrow pnpm override moves that version to the upstream patched **12.0.2**, with the lockfile committed. The gate was not weakened and no runtime advisory exception was added. Generated contracts, API/GraphQL regressions and production images were checked again; Gemini model/SDK settings are unchanged. The independent development-only exception above remains subject to its existing expiry.

## Build and secret handling

```sh
pnpm ci:workflows
pnpm security:scan
pnpm docker:build
pnpm docker:smoke
```

The shared multi-stage `infra/docker/Dockerfile` has three final targets. Builds install all workspaces from the lockfile; `pnpm deploy --prod` packages API/worker compiled dependency closures including canonical contract files. Next.js uses standalone output and copies static assets. Runtime stages contain neither the build toolchain nor root development dependencies. All final targets run as 10001:10001, expose liveness checks, and bind inside the container to 0.0.0.0. API/worker dependency readiness remains a separate endpoint. Compose `service_healthy` checks liveness; operators must check readiness before traffic cutover. Graceful termination has a 30-second allowance in the example.

`.dockerignore` excludes Git, environment/registry credentials, local dependencies and build/test artifacts. Builds need no application secrets. For a private registry, use `docker build --secret id=npmrc,src=/absolute/private/npmrc --target api -f infra/docker/Dockerfile .`; BuildKit mounts the file only for install/deploy instructions. Never use ARG/ENV, cache exports or public Next.js variables for secrets. A private registry secret must never be available to fork/PR builds; the provided workflows use public dependencies and pass no build secrets.

At runtime `node --import ./entrypoint.mjs` loads allowlisted `*_FILE` secret mounts before validating the application's environment. It rejects simultaneous inline/file definitions and unreadable/empty secrets without logging their contents. Database URLs, Redis URL, API key and S3 credentials use this mechanism. Rotation requires replacing the file and restarting the relevant service; the API key also encrypts cursors/webhook secrets, so rotate with an explicit stored-secret re-encryption plan. Do not casually regenerate it during a deploy.

## Example deployment and migration before cutover

`infra/deploy/compose.yaml` is the application tier for a single Linux amd64 Docker host behind a host-managed TLS proxy. Managed/private PostgreSQL 17 + pgvector, Redis with persistence/noeviction, and MinIO/S3-compatible storage must already exist. The current readiness adapter specifically expects MinIO's health URL. PostgreSQL extensions must be provisioned by an administrator. Redis queue namespace and provider/model configuration must match across replicas. Synthetic model/mock drafting remains the supported default; these images do not establish production semantic AI quality. Authenticated dashboard access, uploads, cited drafting and reviewed Internal only messages are implemented; see the [measured live acceptance](../verification/live-acceptance-2026-10-23.md). External customer delivery remains unimplemented. Deployment validation is separate from application acceptance.

1. Preserve the current deployment env, all three digest manifests, schema-migration checksums, provider settings and secret versions. Take a database snapshot/PITR checkpoint and verify the restore procedure. Keep object versions, Redis persistence and immutable evidence identifiers. Capacity-check indexing/draft queues and review DLQ state.
2. Download all three image manifests from the **same successful release run**. Verify repository/revision and provenance against the reviewed commit. Authenticate the deployment host to private GHCR with a read-only package credential from a secret manager; workflow `GITHUB_TOKEN` is not a long-lived deployment credential. Retain the previous images/manifests for rollback.
3. Copy `infra/deploy/release.env.example` to `/etc/resolvehub/release.env` and replace every zero digest and example hostname. This file contains references/configuration only. Store secret files outside the checkout under `RESOLVEHUB_SECRETS_DIR`: `migration_database_url`, `api_database_url`, `worker_database_url`, `redis_url`, `api_secret_key` (64 lowercase hex characters), `s3_access_key_id`, `s3_secret_access_key`. The migration login owns schema objects; API and worker logins must be separate NOSUPERUSER NOBYPASSRLS members of their named NOLOGIN groups, own no tables and have no schema-create permission. Never put the migration URL in an application service. Scope storage credentials to the private bucket; avoid MinIO root credentials.
4. Use PostgreSQL verified TLS, `rediss://` and HTTPS MinIO. Configure trusted private certificate chains with additional read-only CA mounts and `NODE_EXTRA_CA_CERTS` as required; never disable verification. URL-encode credentials. Compose file-backed secrets must be readable by UID 10001; protect their host directory (0700) and mount individual read-only files (0444 inside the container). Docker Compose file mounts do not implement arbitrary secret UID remapping; validate ownership on the target platform. Do not print `docker inspect` environments or rendered secret contents.
5. Validate and pull the immutable image set:

   ```sh
   pnpm deploy:check /etc/resolvehub/release.env
   docker compose --env-file /etc/resolvehub/release.env -f infra/deploy/compose.yaml config --quiet
   docker compose --env-file /etc/resolvehub/release.env -f infra/deploy/compose.yaml pull api worker web
   ```

6. Keep current traffic on the old stack. Run the **new API image** one-off with migration credentials, before starting the new applications:

   ```sh
   docker compose --env-file /etc/resolvehub/release.env -f infra/deploy/compose.yaml run --rm --no-deps migrate
   ```

   This invokes `migrate.mjs --grants`: checksummed ordered SQL under an advisory lock/transaction, then transactional least-privilege group grants. Repeat application is safe. A migration failure stops deployment; inspect administrator logs and keep the old stack serving. Migration transactions and grants are separate, so a failed grants step requires a retry even if migrations committed. On first install the grants command creates the NOLOGIN groups and needs role-creation authority; an administrator can precreate those groups so the routine migration login does not need CREATEROLE. Provision the separate login memberships through the secret-management/admin workflow. No production seed runs.

7. Start/recreate worker, API and web against the expanded schema with `docker compose ... up -d --wait --wait-timeout 120 api worker web` (replace `...` with the same env/file flags). The single-host example involves a brief service restart; it does not claim zero downtime. For zero-downtime promotion use two application projects and a load balancer, preserving DB/Redis/storage and validating version-compatible queue payloads. Avoid running incompatible workers concurrently. Apply expand → migrate → contract; remove old fields only after the rollback window closes.
8. Verify `/health/ready` on API/worker and web `/api/status` **body** `status: ready` (the web status route returns HTTP 200 even when dependencies are down). Check a synthetic authenticated ticket mutation, scoped GraphQL read, queue completion, citation source visibility and human review. Health responses never require business credentials. Use an operator-only network for worker health. Switch proxy traffic only after readiness and the synthetic check pass. `infra/deploy/Caddyfile` shows same-origin `/v1/*` and `/graphql` forwarding; keep API health private. Caddy must obtain/serve valid TLS for the exact WEB_ORIGIN hostname. Observe error rates, queue age/retries/DLQ and readiness after cutover.

The deployment validator rejects mutable image tags, zero placeholders, non-HTTPS origins/storage and relative secret paths. It does not prove secret validity, connectivity, digest provenance, same-revision grouping or cloud infrastructure provisioning; those are explicit promotion checks above.

## Rollback

- **Failed validation/build/test:** no publishing job runs. Fix in a reviewed PR. If some publication matrix entries failed, do not deploy the partial set; rerun to produce a new set of unique references.
- **Application regression with compatible expanded schema:** stop promotion/traffic, pause intake if needed, gracefully stop new workers, restore the previous `/etc/resolvehub/release.env` with its three recorded digest references and compatible configuration/secret versions. Run `pnpm deploy:check`, pull those images, then `docker compose --env-file /etc/resolvehub/release.env -f infra/deploy/compose.yaml up -d --wait --wait-timeout 120 api worker web`. Verify API/worker readiness, web status body, synthetic operations and queue completion before restoring traffic. Keep the **forward database schema**; do not run old down migrations. Preserve already-created drafts/audits/jobs and previous active document indexes. Reconcile new job payload compatibility and DLQ through authenticated replay; never blindly purge Redis or replay outbound actions.
- **Migration failure:** the failing migration batch rolls back. Applied history is checksummed; never edit it to make CI green. Repair with a new forward migration. If grants failed after migration commit, retry grants/migration command under the administrator role.
- **Destructive/incompatible migration or corruption:** stop writers/workers and isolate traffic. Restore the tested database backup/PITR point into a separate instance, reconcile object versions and queue/domain receipts, then point a complete compatible image/secret set at it. Record the acknowledged data-loss window and recovery owner. The initial `packages/db/rollback/0001_initial.sql` is only a scratch-database bootstrap test procedure, not a production downgrade strategy. See [database operations](database.md) and [ingestion recovery](ingestion-recovery.md).

Record the incident, released/rolled-back digests, migration history, secret versions, operator, timestamps and post-rollback checks. Keep prior images from package-retention cleanup until the rollback window and backup retention policy allow removal.

The internal dashboard adds separate `api_s3_access_key_id` / `api_s3_secret_access_key` secret files for API staging. Give this credential private upload-write permissions; keep worker read permissions separately scoped. Apply migration 0012 before the new API, worker and web images. Internal approvals and ticket messages persist across rollback; use the [internal support rollback notes](internal-support.md#storage-and-deployment).
