# Observability and recovery

Milestone 08 exports application traces and metrics with OpenTelemetry over OTLP/HTTP. Telemetry is optional and disabled by default. It never authorizes access or changes a job's durable result. See the [measured performance report](../performance-report.md) and [design decision](../architecture/decisions/0009-private-operational-telemetry.md).

## Local setup

```sh
pnpm observability:up       # creates private .env.observability once; preserves data
pnpm observability:check    # pinned Collector validation, promtool config/alert tests, dashboard JSON
pnpm observability:verify   # readiness and authenticated Grafana provisioning
```

Set `OTEL_ENABLED=true` in the existing ignored `.env`, then restart `pnpm dev` or `pnpm start`. The default endpoint is `http://127.0.0.1:4318`. No additional application credentials are required locally. `OTEL_TRACE_SAMPLE_RATIO` is a root sampling probability from 0 to 1; incoming W3C sampling decisions are respected. `OTEL_METRIC_EXPORT_INTERVAL_MS` accepts 1000–60000, default 5000. Validation errors expose field names only. Do not enable customer headers, baggage, SQL statements, Redis arguments or provider bodies through generic SDK environment configuration.

Open [Grafana](http://127.0.0.1:3003/d/resolvehub-operations), username `admin`, using the generated password in mode-0600 `.env.observability`. Keep that file private. Grafana uses the password only when its database is initialized: preserve the file with its volume; changing the file does not reset an existing account. [Prometheus](http://127.0.0.1:9090) and [Tempo](http://127.0.0.1:3200/ready) are separate local services. Ports 3003, 3200, 9090, 4317, 4318 and 13133 bind to loopback. `pnpm observability:down` stops this independent Compose project and retains its volumes. It does not stop PostgreSQL, Redis, MinIO or the applications.

The dashboard covers HTTP p50/p95/p99, GraphQL failures, draft completion percentiles, queue wait/age/depth, retries, unreplayed dead letters, ingestion throughput, retrieval and generation latency, tokens, cost and telemetry freshness. Tempo Explore accepts TraceQL such as `{ resource.service.name = "resolvehub-worker" }`. Trace IDs are operational identifiers; customer/job/tenant IDs are deliberately absent. A request ID and a trace ID serve separate purposes.

## Trace and metric semantics

API and worker entrypoints initialize the SDK and ESM instrumentation hook before dynamically loading application code. PostgreSQL and ioredis spans require an active parent. HTTP uses bounded route templates; GraphQL records only allowlisted schema field names, never operation names, variables, query text or responses. The web status route forwards W3C context to API and worker health requests. Framework-generated web spans pass through the same export redactor.

The API transaction stores an allowlisted `traceparent` beside the durable job receipt. The dispatcher reloads it through tenant-scoped SQL, creates a producer span and supplies BullMQ's separate telemetry metadata. The domain envelope remains the same two immutable identifiers. A worker consumer extracts only this W3C parent and reloads authoritative tenant state. Retries retain the initiating trace; manual replay starts with its newly authorized request. Legacy receipts with `{}` and jobs without metadata remain valid and start a new trace. Baggage and tracestate are discarded.

All application metrics begin `resolvehub_`. Prometheus appends `_total` to counters and `_bucket`, `_sum`, `_count` to histograms. Durations use seconds, cost uses USD, tokens use estimated mock or validated provider counts. Histogram boundaries include exactly 0.02 USD and 6 seconds. Labels are fixed enums for route/method/status class, schema field, operation/stage, outcome, job kind, provider and bounded model labels. An arbitrary configured model is `operator-configured`. There are no tenant/resource/request/customer metric labels. Each service replica receives a random `service.instance.id`; discard expired replica series through normal retention rather than treating them as tenant dimensions.

- HTTP duration runs until response finish/close. GraphQL duration includes parsing/execution and counts GraphQL errors even when HTTP returns 200.
- `queue_pending`, `queue_active`, `queue_oldest_age_seconds`, `queue_dead_letters`, and `queue_retries_durable` are authoritative PostgreSQL aggregates across organizations, refreshed every five seconds. **Use max across worker replicas**, because each sees the same global state. API credentials cannot call the security-definer aggregate. It returns no identifiers or customer fields.
- Queue waiting time starts at the later of receipt creation and retry availability, excluding deliberate retry backoff. Oldest age includes accepted and processing work, including blocked/retrying jobs; it measures age since receipt, not just Redis waiting time.
- Retry and dead-letter event counters are emitted after the durable failure transaction commits. A process crash between commit and metric emission can undercount events; use durable retry and unreplayed dead-letter gauges for recovery decisions. Durable retry totals reflect retained job rows, not a permanent billing ledger.
- Ingestion throughput counts successful atomic publications; duplicate skips do not count. The duration histogram covers successful attempts. Failure duration and categories of operation are available through operation spans/counters and the durable job API.
- `draft_duration_seconds` runs from original receipt creation to committed completion, including retries. Retrieval duration includes query embedding, retrieval and optional rerank. Generation timing includes provider rate limiting. Operation histograms also cover failures. Token/cost counters count validated receipts, including attempts whose evidence is later rejected; completed draft cost includes previously accounted attempts. `model_usage_incomplete` marks generation calls that fail before usage is available. Unknown provider usage must never be interpreted as zero spend.

SDK span buffering is bounded to 2048 spans, exports time out, and shutdown flushes after application resources close. Collector memory and retry queues are bounded. Export failures may drop telemetry; application mutations keep their original outcome. `telemetry_export_failures` becomes visible after export recovers. Metrics can also be lost across an outage/process exit; the database remains authoritative.

## Request failures

For HTTP/GraphQL failure alerts, compare dependency readiness with error rates and inspect sanitized traces for failed operations. Use the authenticated REST job status and request ID to inspect authorized domain details. Do not add customer content to spans to debug an incident. A failed health probe alone is not evidence that an accepted mutation was rolled back; check its idempotent receipt before retrying.

## Slow drafts

Compare queue wait with RAG retrieval and generation durations. Check worker/provider concurrency limits, database plans and provider timeout/429 behavior. Keep the four-attempt budget and the human approval gate. A low API POST duration measures admission, not completion: use the draft duration histogram and the k6 end-to-end trend for the six-second target. See [AI drafting operations](ai-drafting.md) before changing models or pricing.

## Queue and dead letters

At 900 pending ingestion receipts investigate throughput; at 1000 admission returns 429 with `Retry-After`. Restore Redis/provider/storage/database readiness before resubmitting idempotently. Never delete receipts, reset attempt counts or clear Redis to conceal a backlog. Inspect the authenticated DLQ and replay only eligible failures through `POST /v1/jobs/{id}/replay`; replay reauthorizes, audits and remains idempotent. Follow [ingestion recovery](ingestion-recovery.md). A failed reindex preserves the previous published document version.

## Model usage

The cost alert detects completed drafts above $0.02, including previously accounted attempts. Unknown-usage alerts require checking provider-side usage/billing through the operator's authorized tooling; estimated application totals cannot reconstruct missing receipts. Synthetic mock tokens are estimates and cost $0 by configuration. No live provider cost or quality is established by the local benchmark.

## Telemetry outage

Check Collector health, Prometheus scrape status and exporter failures. Restart only the failed observability service with `pnpm observability:up`; preserve volumes. A stale queue observation means the worker could not refresh SQL aggregates, so inspect database readiness. If an entire worker dies, normal worker readiness/process monitoring must detect it; the last exported gauge alone cannot detect a stopped process forever. Collector metric expiry is two minutes, so short dashboards may temporarily include a stopped replica.

Prometheus loads alert definitions and evaluates them locally. Alertmanager, paging routes, production service discovery and an external uptime check are not configured by this example. Configure them before relying on alerts for on-call notification.

## Deployment, privacy and rollback

The application-tier [deployment example](../../infra/deploy/compose.yaml) accepts the same OTEL settings. Use a private reachable OTLP/HTTP Collector endpoint with TLS and network-level authentication/authorization appropriate to the deployment; the local anonymous loopback receivers are not public endpoints. No OTLP credential is embedded in the repository. The four local observability images are pinned by digest, non-root, capability-restricted and have bounded memory. Review exported schemas whenever adding instrumentation.

The SDK reconstructs spans before buffering and allowlists metric names and attributes before export. It drops span events, links, status messages, URLs, SQL, Redis arguments, exception text, headers, variables, prompts, completions, document passages and customer/resource IDs. Resource detection and payload diagnostic logging are disabled. The Collector applies a second attribute/name boundary. Tests and the benchmark send private canaries through real HTTP/storage/database paths and assert they never reach exported traces. The Collector is a trusted internal receiver, not a sanitizer for arbitrary untrusted OTLP producers.

Migration `0011` is additive: trace context defaults to `{}`, and a restricted aggregate function is added. Run the normal migration and reapply `infra/docker/worker-grants.sql` using migration credentials before rolling out workers. Old application images ignore the extra column and BullMQ metadata. Roll back application digests or set `OTEL_ENABLED=false` and restart; **leave the additive migration in place**. Do not drop job receipts, traces or data volumes during an application rollback. See [release operations](releases.md) for image promotion and database backups.
