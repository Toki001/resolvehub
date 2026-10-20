# Contract API operations

## Setup and credentials

```sh
make setup
make up
pnpm db:migrate
pnpm dev
```

`pnpm env:setup` (also run by `make setup`) generates a random 256-bit API secret in private, ignored `.env`, preserving an existing valid value. An invalid or duplicated existing key fails setup instead of silently rotating it. `API_SECRET_KEY` must be 64 lowercase hex characters. Back it up separately from the database. Rotating it invalidates cursors and requires re-encrypting webhook signing secrets; changing it blindly makes existing integrations unavailable.

Provision an organization and an expiring API credential in another terminal:

```sh
pnpm auth:bootstrap --organization 'Synthetic Support' --subject admin@example.test --webhook
```

The command requires trusted database administration access. It displays the API credential and optional webhook signing secret once. Do not commit them, put them in browser storage, or paste them into logs. API credentials expire after 24 hours. To issue an agent/analyst credential for an existing organization, use `--organization-id <uuid> --subject <email> --role agent` (or `analyst`). Provisioning the same active subject/role rotates its credentials and revokes prior ones atomically; it does not change roles or reactivate memberships. Webhook secrets are independently provisioned and existing integrations remain active until revoked in the administration database.

## REST commands

Canonical definitions are in `packages/contracts/openapi.yaml`. All bearer mutations require a 16–128 character `Idempotency-Key` using letters, digits, `_` or `-`. Body fields not declared in the contract are rejected. `X-Request-ID` may be a UUID; otherwise the server generates one. Every attempt returns its own request-ID header. A replay returns the original status/body, including an asynchronous job's original correlation ID.

| Operation                          | Behavior                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /v1/me`                       | Verified organization, membership, subject and role                                     |
| `POST /v1/tickets`                 | 201; atomically creates a ticket and customer message                                   |
| `POST /v1/documents/ingestions`    | 202; accepts staged-object metadata and creates document/version/request records        |
| `POST /v1/tickets/{id}/drafts`     | 202; accepts an accessible ticket's draft request                                       |
| `POST /v1/documents/{id}/versions` | 202; immutable replacement upload, with the previous publication retained on failure    |
| `GET /v1/jobs/{id}/failure`        | 200; tenant-scoped durable failure details and attempt history                          |
| `GET /v1/jobs/{id}`                | Actual tenant-scoped persisted request state                                            |
| `POST /v1/jobs/{id}/replay`        | Admin-only 202; one accepted child for a failed source, original failure preserved      |
| `POST /v1/drafts/{id}/approve`     | 200; audited human decision, expected revision and current published citations required |
| `POST /v1/drafts/{id}/reject`      | 200; audited rejection with reason and expected revision                                |
| `POST /v1/webhooks/tickets`        | Signed integration authentication; 202 receipt with event deduplication                 |

An ingestion object key must be exactly `organizations/<authenticated-organization-id>/uploads/<uuid>`. Arbitrary URLs, traversal and other organization namespaces are rejected. The caller stages bytes through an authorized storage flow; this milestone does not issue upload URLs. The later ingestion worker validates object existence, size, MIME and hash. Document ingestion is now processed by the milestone 04 worker; see [ingestion and recovery](ingestion-recovery.md). Draft and webhook domain requests remain accepted until their processors are implemented.

Approval never sends a reply. It requires a pending draft, matching revision, a previously validated evidence flag and at least one citation still belonging to an active published version. Absent, stale or cross-tenant evidence returns 422. Repeated decisions with a new key conflict with the current state; retries with the original key replay the receipt. Draft creation/generation itself is deferred.

Example with a credential obtained above:

```sh
curl http://127.0.0.1:3001/v1/tickets \
  -H "Authorization: Bearer $RESOLVEHUB_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  --data '{"subject":"Account access","customerEmail":"customer@example.test","message":"Please help me sign in."}'
```

Errors use `{code,message,requestId,details?}`. Invalid input is 400; invalid credentials 401; role denial 403; missing/inaccessible resources 404; state/key conflict 409; oversized JSON 413; unreviewable evidence 422; ingestion capacity 429 with Retry-After; dependency failure 503. Bodies are limited to 64 KiB. Authenticated CORS permits the configured origin and explicit request headers, with no credential cookies.

## Signed webhooks

Send `X-Webhook-ID` (integration UUID), `X-Webhook-Timestamp` (Unix seconds), and `X-Webhook-Signature` (`v1=` followed by lowercase hex HMAC-SHA256). Use the displayed secret string as the UTF-8 HMAC key. The signed bytes are:

```text
timestamp + "." + exact UTF-8 HTTP request body
```

The JSON body contains `{eventId, ticket:{subject,customerEmail,message}}`. Sign after final serialization. Timestamps outside ±300 seconds fail before mutation. Resign retries using a fresh timestamp, retaining the original event ID. Identical logical events replay the receipt; changed content under the same event ID conflicts. No tenant field in the body or headers authorizes an organization.

## GraphQL reads and generated clients

POST JSON to `http://127.0.0.1:3001/graphql` with `Authorization: Bearer ...` and `Content-Type: application/json`. The canonical SDL is `packages/contracts/schema.graphql`; executable operations are in `packages/contracts/operations/workspace.graphql`. Roots: `tickets`, `ticket`, `knowledgeDocuments`, `knowledgeSearch`, `draft`, `dashboardSummary`.

Connections use `first` (default 20, range 1–100) and `after`. Ordering is immutable `(createdAt DESC, id DESC)`, using millisecond precision and a timestamp cutoff. AES-GCM cursors bind organization, query kind, filters, cutoff and last ordering keys, and expire after 24 hours. They are opaque; callers must not parse or construct them. Changing filters or using another organization's cursor fails. Nested ticket messages/drafts are bounded to 100 items each; request details separately when list expansion exceeds the 2,000-cost/12-depth budget. Knowledge search returns only active published chunks, using literal text matching without fabricated confidence scores.

GraphQL execution errors use `errors[].extensions.{code,message,requestId,httpStatus,details?}` with the standard GraphQL `data/errors` envelope. Valid executions with business/auth errors use HTTP 200; parse/validation/budget failures generally use 400. HTTP parser/size failures use the REST error envelope before GraphQL execution. Successful GraphQL responses expose `extensions.requestId`; no stack traces are returned. Introspection and batched requests are disabled.

`pnpm generate` runs openapi-typescript and GraphQL Code Generator's **client preset**. REST callers use `createApiClient(baseUrl, token)` from `@resolvehub/generated`; its `POST`/`GET` methods carry generated input/output types. GraphQL callers import typed document constants such as `TicketsDocument` and `TicketDetailsDocument`; they work with typed-document-node clients and `graphql`'s `print`.

## Verification and drift gates

- `pnpm check`: format, lint, strict types, OpenAPI/SDL validation, exact REST controller inventory, unit/contract tests.
- `pnpm contracts:drift`: regenerate then fail on changed, deleted or untracked generated sources. Intended new generated files must be staged before running the local check. CI checks the committed outputs.
- `pnpm test:integration`: real running API/worker and PostgreSQL; creates isolated synthetic organizations and removes them afterward.
- `pnpm build`, then `pnpm start`: compiled local stack, with production Node mode.

Run migrations before startup; readiness requires the current contract migration. The migration runner checks applied SQL checksums and supports repeated runs. Never edit an applied migration. Use additive follow-up SQL and preserve idempotency/audit records. No automatic retention/pruning, public auth management API or outbound messaging is supplied. Later milestones added full persistence, fixtures and tenant policies; milestone 04 supplies the document worker and durable DLQ. Legacy draft/webhook processors remain deferred.
