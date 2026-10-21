# 0010 — Authenticated dashboard and transactional internal replies

Accepted for the requested internal support workflow, 2026-10-21. This extends the completed eight infrastructure/backend milestones with usable dashboard operations.

## Decision

Use Next.js server components and Server Actions as an authenticated server-side client of the existing API. REST remains the mutation boundary; schema-first GraphQL remains the read boundary. Generate all added client types/documents from canonical contracts. Validate GraphQL responses at the web boundary and keep API, database and storage secrets out of browser JavaScript. Existing expiring membership access keys establish host-only HttpOnly sessions; each operation still authenticates and authorizes at the API. No tenant input is authority.

Server Actions use Next.js Origin protection plus an explicit matching Origin/Host check, bounded body size, bounded API timeouts and idempotency keys retained on retries. See [Next.js Server Actions configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions) and [data security guidance](https://nextjs.org/docs/app/guides/data-security). An opt-in loopback/development-only bootstrap provisions a reserved synthetic account for local use. Production has no bootstrap fallback or unauthenticated registration route.

Stage private files through a contract-defined API operation. The API computes the namespace/hash/size and uses its own storage credential; web code never signs arbitrary object keys or accesses MinIO directly. Existing durable ingestion owns validation, indexing, retries and preservation of an active document version. Keep upload and index commands separately idempotent so a failed admission can be retried without inventing success.

Pending drafts can be edited with optimistic revision control. Preserve the original generated wording, editor/time and audit events. Keep AI source quotations intact and recheck their current eligibility at approval. Edits are human-authored wording, not automatically supported model claims; require explicit reviewer acknowledgement. Abstentions or invalid/stale evidence remain ineligible for approval. Approved/rejected drafts are immutable through the application workflow.

The user selected internal replies only. Inject `ReplyDelivery` into the API review service and call its `stage` method inside the same transaction as approval. `InternalReplyDelivery` writes one agent ticket message with delivery status `internal`, links its source draft and audits the message. Tenant/ticket/draft composite ownership and a unique tenant/source-draft index provide defensive constraints. Concurrent review commands serialize on the draft row. Failed message insertion rolls back approval and its idempotency receipt. Rejection records no agent message.

Future delivery adapters must stage outbox work and dispatch after commit; no external network delivery belongs in a database transaction. No SMTP/webhook adapter or configuration is implemented. Customer-context recording is a distinct command with author fixed to customer; it cannot bypass human approval by posting an arbitrary agent reply.

## Consequences

Dashboard workflows are functional against persisted records, while empty, signed-out and dependency-error states remain distinct. Membership role determines visible actions and API authorization remains decisive. Review/job/message reads gain bounded opaque cursor pagination; the legacy bounded message list remains compatible while the dashboard can retrieve older history.

Cookie sign-out is local session termination rather than revocation of all integrations using the access key. An identity provider/password flow, membership administration UI, automatic storage-orphan pruning and external messaging remain separate work. Current local generation is explicitly identified as a mock extractive provider. Historical approvals are not backfilled into new replies: only approvals performed through the new delivery-capable transaction create linked internal messages.
