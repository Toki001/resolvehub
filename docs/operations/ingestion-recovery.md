# Ingestion and recovery

Run `pnpm db:migrate` before restarting API/worker processes. Migration 0007 adds durable handoff scheduling, requester identity, extraction checkpoints, attempt history and application dead letters. Application startup never migrates. The worker now needs PostgreSQL and S3 credentials as well as Redis; see `.env.example`. Existing local MinIO root credentials are accepted as a local fallback. Deployments must provide scoped S3 credentials and distinct non-owner API/worker database logins.

Apply `infra/docker/runtime-grants.sql` and `infra/docker/worker-grants.sql` as the migration administrator. API logins inherit `resolvehub_runtime`; worker logins inherit `resolvehub_worker`, with their URL set through `WORKER_DATABASE_URL`. Keep migration credentials outside application traffic. The worker can dispatch bounded tenant/job identifiers but cannot globally select domain tables. The API cannot call worker dispatch.

## Submit and inspect work

1. Obtain an expiring bearer token through the [authentication bootstrap](contract-apis.md). `GET /v1/me` provides its verified organization. The service never accepts a caller-supplied organization as authorization.
2. Create the configured local bucket in the MinIO console at `http://127.0.0.1:9001` if it does not exist. Stage a UTF-8 `.txt`/`.md` file or a text-bearing PDF under `organizations/<verified-organization-uuid>/uploads/<lowercase-upload-uuid>`. For production, provision the bucket and restricted upload/read policies through deployment administration. Ingestion itself has no bucket-creation permission requirement.
3. Compute the exact uploaded byte length and SHA-256. Submit the following to `POST /v1/documents/ingestions` with bearer auth and an `Idempotency-Key` of 16–128 permitted characters:

```json
{
  "title": "Synthetic refund policy",
  "objectKey": "organizations/<verified-organization-uuid>/uploads/<lowercase-upload-uuid>",
  "mediaType": "text/plain",
  "sizeBytes": 123,
  "sha256": "<64-lowercase-hex-characters>"
}
```

The placeholders and byte count must be replaced with the actual staged object metadata. Supported media types are `text/plain`, `text/markdown`, `application/pdf`; maximum raw size is 10 MiB. Invalid or missing objects fail permanently after acceptance. PDF extraction does not provide OCR; image-only/empty PDFs fail validation.

The response is 202 with `jobId`, `statusUrl`, `requestId` and `Location`. Poll `GET /v1/jobs/<jobId>` for authoritative state. `accepted` includes durable handoff and delayed retries; `processing` means an attempt was claimed; `succeeded` means publication and job completion committed together. `resourceId` identifies the knowledge document. Repeating the original Idempotency-Key replays its original receipt even after completion or during admission saturation.

For a replacement, submit `POST /v1/documents/<documentId>/versions` with the same upload metadata **without `title`**. Each request creates an immutable new version; the document retains its title. Use a new Idempotency-Key for a new revision. The old active index remains searchable through a failed replacement. Only successful publication changes the active pointer. Older revisions cannot replace an already published newer revision. Existing GraphQL `knowledgeSearch` reads live published chunks using literal matching; semantic retrieval quality is not claimed.

## Limits and retry policy

| Setting/rule                    | Default or bound                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `WORKER_CONCURRENCY`            | 2, validated 1–16; applied locally and globally to the ingestion queue                       |
| `INGESTION_QUEUE_PREFIX`        | `resolvehub`; all replicas for the same deployment must agree                                |
| `EMBEDDING_REQUESTS_PER_SECOND` | 10 shared batch requests/second, validated 1–100                                             |
| `EMBEDDING_TIMEOUT_MS`          | 5,000; validated 100–30,000                                                                  |
| `INGESTION_ATTEMPT_TIMEOUT_MS`  | 60,000 cooperative cancellation; validated 1,000–120,000                                     |
| Download/extraction             | Each bounded to 10 seconds; PDFs also run in a resource-limited thread                       |
| Extracted content               | At most 200,000 characters/200 PDF pages, no OCR                                             |
| Chunking                        | 1,000 characters, 100 overlap, at most 256 chunks, 16 embeddings per batch                   |
| Attempt budget                  | Four claimed processing attempts, persisted in PostgreSQL                                    |
| Retry delay                     | Exponential 1/2/4-second bases with 50–100% jitter; provider Retry-After may extend it       |
| Admission                       | At most 1,000 unfinished ingestion runs, including active and delayed work                   |
| Excess admission                | HTTP 429, `CAPACITY_EXCEEDED`, `Retry-After: 30`                                             |
| Interrupted processing lease    | Due for dispatch after 150 seconds; live session lock still prevents a duplicate             |
| Redis retention                 | Completed: one day/1,000 records; failed: seven days/1,000 records, cleaned lazily by BullMQ |

Extraction caches, staged chunks and embedding checkpoints are tenant/version-scoped. Retry and manual replay reuse completed checkpoints. Partial embedding batches roll back; committed earlier batches remain staging data until publication. Document contents, storage credentials, provider error bodies and stack traces are never written to dead-letter summaries. Request IDs correlate API, job and failure records; full distributed tracing remains a later milestone.

The active embedding adapter is synthetic, versioned and 64-dimensional. The limiter/timeout interfaces support provider integration, but no live external embedding service or semantic quality claim ships here. Change models/dimensions only with a new migration and reindex plan.

## Inspect and manually replay a dead letter

`GET /v1/jobs/<failedJobId>/failure` returns tenant-authorized category, safe summary, request ID, input fingerprint, replay eligibility and up to four attempt records with stage/start/end/outcome. Cross-tenant and absent records return 404. The application DLQ is PostgreSQL `failed_jobs`, independent of BullMQ retention.

An active tenant administrator can call:

```sh
curl -X POST "http://127.0.0.1:3001/v1/jobs/$FAILED_JOB_ID/replay" \
  -H "Authorization: Bearer $RESOLVEHUB_TOKEN" \
  -H "Idempotency-Key: $REPLAY_IDEMPOTENCY_KEY"
```

Choose one new replay key and keep it for transport retries. Replay returns a new 202 job receipt, audits the action, reserves admission capacity and preserves the original failed run. One failed run can have one replay child; another new key conflicts after that child exists. If the child later exhausts its own four attempts, inspect that child's failure before another explicitly authorized replay. Agent/analyst roles cannot replay. Do not use raw BullMQ retries or edit database attempt counters as an operator shortcut.

`replayEligible: false` means a permanent file, authorization or version-state issue, or an already replayed run. Correct invalid file/type/size/hash/content by staging a corrected object and requesting a **new document version**. Restore valid membership authority before issuing a new authorized request. Old failed synthetic fixtures created before worker execution have no fabricated attempt history; they cannot be used as live replay demonstrations without staged objects and an actual processed failure.

## Recover dependencies and interrupted workers

- **Redis unavailable:** API requests remain durable in PostgreSQL up to the admission cap. Readiness reports down; no Redis success is fabricated. Restore Redis and its persistence volume. Dispatch resumes automatically; absent/completed/failed Redis delivery records for still-due database work are reconstructed. Existing idempotency receipts still replay. Never delete PostgreSQL handoffs to clear a Redis incident.
- **Embedding timeout/rate limit/outage:** inspect job reason and history. Calls are bounded, retry with jitter, and use the shared model limiter. A provider Retry-After extends the retry delay. Four claimed failures create a durable dead letter. After restoring the adapter/provider, an administrator can replay eligible failures. Successful checkpoints are reused and the previous active document remains published.
- **MinIO unavailable:** restore its endpoint, credentials and volume. Transient storage errors use the same finite retry policy; exhausted runs require authorized replay. Missing objects, unsupported content type, mismatched size/hash, invalid UTF-8/PDF and empty content are permanent. Stage a corrected immutable upload and request a new version.
- **Database unavailable:** API acceptance fails safely with 503 instead of claiming a persisted request. A worker cannot commit publication or dead letters while PostgreSQL is down. Its original durable handoff remains authoritative; restore PostgreSQL and let the processing lease expire. Recovery records an abandoned claim and retains the four-attempt budget. Redis failure events are never the sole source of failure persistence.
- **Worker exits or loses its database session:** the advisory lock is released by PostgreSQL. Restart with the same deployment prefix/model configuration. A due lease is dispatched again and rechecks organization, membership and document/version state before fetching content. Incomplete claims are marked abandoned; completed checkpoints resume. Graceful shutdown aborts active external calls and closes consumers; the process has a ten-second shutdown ceiling, after which the lease-based recovery path applies.
- **Partial database write:** embedding batches and final publication are transactional. A failed batch leaves no half-batch vectors. A failure after changing the pointer but before the audit rolls the pointer, version statuses and job completion back together. Repair the database cause; automatic retry or an eligible manual replay resumes safely. Do not manually publish staged chunks.
- **Backlog reaches 1,000:** inspect failed/accepted job counts, dependency readiness and worker logs without dumping document text. Restore the bottleneck, wait for terminal completions to release capacity and respect Retry-After. Scale replicas only within the same global concurrency/provider limits; changing each replica's prefix would create independent queues/limiters and is not a capacity repair.

Run `pnpm test:integration` against a compiled local stack to verify the real API pipeline and isolated failure suite. The suite uses the pinned Redis image via Testcontainers, real MinIO objects and disposable PostgreSQL schemas. It explicitly cleans up its own resources and disables the separate Ryuk helper image. It does not stop the shared Compose Redis/PostgreSQL services. Large-scale throughput, live provider behavior, OCR, outbound replies, draft generation and telemetry are outside this milestone.
