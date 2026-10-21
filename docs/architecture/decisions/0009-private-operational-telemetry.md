# 0009 — Early, bounded and private operational telemetry

Accepted for milestone 08, 2026-10-21.

## Decision

Add `packages/telemetry` as a small operational dependency of web, API, worker, database and AI packages. It owns fixed span names, bounded metric labels, W3C context handling, privacy processors and SDK startup. It has no domain or transport dependency. Application services keep their own resource lifecycle; telemetry shutdown follows resource closure. Strict environment parsing runs even when export is disabled.

The Node entrypoints initialize the SDK and register the ESM instrumentation hook before importing NestJS, pg, ioredis or worker application code. PostgreSQL and Redis use official instrumentation; HTTP, GraphQL, durable queue stages and RAG use explicit spans. Next.js loads the SDK through its server instrumentation hook with external package preservation. See [OpenTelemetry ESM support](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md).

Durable job receipts store only a validated `traceparent`, in the same transaction as acceptance. Dispatch creates a producer child and passes that parent in BullMQ's separate telemetry metadata. Domain payloads stay compatible with existing consumers. Tenant-scoped reloads, receipt validation and authorization remain independent of trace metadata. A trace is diagnostic evidence, never an authorization claim. A replay creates a fresh authorized trace; legacy empty context is valid.

Privacy uses an allowlist before buffering/export, rather than a denylist of known secret names. Readable spans are reconstructed explicitly; events, links, raw exception/status text, automatic host/process resources and arbitrary scope names are removed. Metric names and both attribute keys and values are bounded. Tokens/cost remain numeric aggregates without tenant labels. A random replica ID enables correct aggregation and benchmark attribution. Collector processing is a second boundary, not the only privacy control. See [Collector transformation guidance](https://opentelemetry.io/docs/collector/transforming-telemetry/).

The dispatcher/worker emit event counters after domain commits. Separate restricted SQL aggregates provide recoverable queue/dead-letter/retry state when an event is lost during a crash. Workers may read global numeric aggregates through a security-definer function with a fixed search path, while API roles cannot. This avoids granting workers unrestricted cross-tenant table reads for metrics. Dashboard queries use max across duplicate worker aggregate observations and sum for local event counters.

Use bounded asynchronous OTLP export and bounded Collector queues. Telemetry failure never rewrites an accepted mutation or published index. Local Grafana/Tempo/Prometheus run as an independent loopback-only Compose project with pinned images and a private generated Grafana password. Prometheus alert tests and real k6/Tempo/Prometheus assertions verify configuration and the actual path.

## Consequences

Customer text, SQL and tenant IDs are intentionally unavailable in traces; domain investigation still uses authenticated APIs and request IDs. Parent-based sampling follows incoming trace flags, so a production trusted ingress must govern caller sampling if necessary. Retained traces and metrics are operational records, not a billing ledger. Export outages or sampling can remove detail, and unknown provider usage must be reported separately.

Adding an operation, model label, metric or schema field requires reviewing the shared allowlist, Collector rules, dashboard/alert queries and privacy tests together. SDK 3.x and matching 0.300.x experimental packages are pinned; narrowly pinned pnpm release-age exclusions permit this verified release set. Upgrade the set together and rerun real PostgreSQL/Redis instrumentation checks. The local stack does not provide production TLS, paging, high availability or remote retention. Mock load results establish this synthetic execution path only.
