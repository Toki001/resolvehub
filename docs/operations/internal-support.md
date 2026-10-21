# Internal support workflow

The dashboard now uses the authenticated REST and GraphQL APIs for real organization-scoped records. It supports ticket creation and status changes, customer context, private document uploads and revisions, background progress, cited drafting, editing, approval, rejection and conversation history. Approved replies remain inside ResolveHub with `deliveryStatus: internal`; no external delivery is performed.

## Start and sign in

```sh
pnpm install --frozen-lockfile
pnpm env:setup
pnpm infra:up
pnpm dashboard:setup
pnpm dev
```

Open [the sign-in page](http://localhost:3000/sign-in) and choose **Open local workspace**. Setup creates a reserved synthetic organization and administrator, prepares the local private storage bucket, applies migrations and writes an expiring credential into private ignored files. It does not replace existing organizations or seed fictional customer conversations. This convenience requires `NODE_ENV=development`, explicit `DASHBOARD_LOCAL_DEMO=true` and a loopback Host; it is unavailable in production. Restart the applications after setup so they read the new environment. The workspace created during implementation is already configured locally.

The demo key expires after 24 hours. Run `pnpm dashboard:setup` and restart `pnpm dev` to rotate only that reserved membership's key. Access details are in mode-0600 `test-results/local-workspace-access.json`; never commit or share this file. `.env` is also private and ignored. Setup refuses a nonlocal database/storage endpoint or an unexpected organization at the reserved ID.

For other organizations, an administrator can run the existing offline `pnpm auth:bootstrap` command. Paste that membership's issued access key into **Workspace access key**. The API verifies the credential and active membership; the browser cannot select a tenant by sending an organization ID. Admins and agents can work on records; analysts have read-only access. Sign out before connecting a different membership.

The session uses a host-only HttpOnly, SameSite=Strict cookie, Secure on HTTPS, with an eight-hour maximum lifetime. API credential expiration/revocation and membership deactivation are checked by the API on requests. Sign-out clears the browser session; it does not revoke a credential used by another integration. Server Actions also require a matching Origin/Host, including for sign-in. Browser storage and client bundles contain no application/database/storage credentials. Use HTTPS outside local development and a trusted reverse proxy that preserves Host. There is no public registration, password reset or automatic production administrator account.

## Work a ticket

1. In **Tickets**, create a subject, customer email and initial question. The resulting ticket and customer message commit together. Lists support subject/status filters and opaque cursor pagination.
2. In **Knowledge Base**, upload a `.txt`, `.md` or `.pdf` source up to 10 MiB. Watch the persisted job progress. Sources become retrievable only after validation and atomic publication. Choose an existing document under Destination to upload a new version; its previous published index survives a failed replacement. The destination menu contains documents on the current paginated document page.
3. Open a ticket and choose **Generate support draft**. Polling reads the real job receipt; a succeeded draft links to its review. Insufficient evidence produces an explicit abstention. It cannot be approved; add relevant knowledge or reject it with a reason.
4. Review the source quotations, model metadata and wording. Edit and save a pending draft when needed. Editing increments its revision, preserves the original generated text, records editor/time and adds an audit event. Only the current revision can be reviewed. Human-edited wording is visibly identified; source validation covers the stored quotations, while the reviewer remains responsible for edited wording.
5. Check the review acknowledgement and choose **Approve & add to conversation**, or expand **Reject this draft** and give a reason. Approval rechecks current published evidence and commits the decision, internal ticket message and audit in one transaction. A unique tenant/draft constraint and idempotent commands prevent duplicate replies. Rejection records the reason and creates no reply. Reviewed drafts cannot be edited or reviewed again.
6. The ticket conversation shows the approved text, review link and **Internal only** status. Record later customer context separately and generate a new draft for corrections. Resolve/reopen/pending actions use deterministic transitions and reject stale state. History pages expose older messages beyond the legacy 100-message read limit.

The Review Queue supports pending, approved and rejected filters with pagination. Settings shows authenticated account information, service health, background jobs and failure histories. Administrators can replay eligible dead letters; an existing replay or permanent nonreplayable failure is explained explicitly. A dependency failure shows an error rather than an invented empty list. Forms retain their fields on unsuccessful requests and use stable idempotency keys for retries.

Drafting uses the existing configured provider. Local `DRAFT_PROVIDER=mock` is explicitly labeled as deterministic source extraction in the review screen; it is not a live model benchmark. The existing optional Ollama adapter remains available through its documented configuration. No paid provider or new model was configured for this implementation. See [AI drafting operations](ai-drafting.md).

## Storage and deployment

The API stages files with `POST /v1/documents/uploads`, a bounded octet-stream request plus an allowlisted `X-Document-Type`. The returned object metadata feeds the existing ingestion/version command. The API derives the object namespace from authenticated membership, computes size/hash and serializes idempotent writes. Parsing and actual byte/type validation remain in the worker. Staging returns 201; asynchronous indexing/drafting/replay returns 202.

Provision a private bucket before production uploads. Grant the API a separate S3 credential for PutObject in authorized upload namespaces and the worker only the access it needs for ingestion. The [deployment example](../../infra/deploy/compose.yaml) now mounts `api_s3_access_key_id` and `api_s3_secret_access_key` separately from worker storage secrets. Web processes receive only API/worker URLs and browser-session credentials; they never receive S3 or database keys. Local Compose can use its existing MinIO development credentials.

A storage timeout/failure rolls back the upload receipt and returns a typed dependency error. Retrying an identical upload key targets the same private object. A crash or admission failure can leave an unreferenced staged object. No automatic orphan cleanup is implemented: inspect document-version references before deleting abandoned objects, and never apply blanket expiry to upload paths that contain referenced sources. The existing 1000-document admission limit and Retry-After response remain authoritative for indexing requests.

Migration `0012_internal_support_workflow.sql` adds edit provenance, delivery status, draft/message ownership and uniqueness, and a tenant/status review index. Existing agent messages are classified as internal; existing approvals are retained without retroactively generating new messages. Run migrations before new application images. Keep the additive migration and internal messages during image rollback. An older API image will stop recording new internal replies on approval, so restore the workflow-capable API before continuing approvals. Do not drop audit/idempotency history to roll back the UI.

## Future delivery adapters

`ReplyDelivery.stage` is an injected API boundary. Its current `InternalReplyDelivery` adapter records the approved message within the caller's transaction. A future SMTP/webhook adapter must stage a durable outbox intent in that transaction, then perform network delivery asynchronously after commit. It must define distinct queued/sent/failed delivery states, retry/idempotency behavior and recipient authorization. The present `internal` status must never be translated into externally delivered. No SMTP client, webhook sender, recipient configuration or delivery secret is installed now.

## Verify

```sh
pnpm check
pnpm test:coverage
pnpm test:dashboard
pnpm docker:build
pnpm docker:smoke
```

The dashboard command builds production output and owns disposable PostgreSQL/Redis/MinIO, temporary membership keys, ports and application processes. It never loads `.env`; browser flows use synthetic records and mock generation. Desktop/mobile checks cover the real upload-to-approved-conversation path, edit/rejection/status/context, HttpOnly session properties, sign-out, read-only controls and tenant switching. Database integration tests additionally exercise concurrent approvals, stale revisions, 100+ message pagination, upload limits and a failed internal-message insert that must roll back review/audit/idempotency state. PR CI includes the isolated browser suite using Playwright Chromium.
