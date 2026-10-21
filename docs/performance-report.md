# ResolveHub performance report — milestone 08

Measured **2026-10-21 05:55:50 UTC** on macOS arm64, 11 logical CPUs, 18 GiB host RAM, Node 22.22.3, pnpm 12.10.1 and k6 2.3.0. PostgreSQL/pgvector, Redis and MinIO were isolated Docker Testcontainers; the web, API and worker ran compiled production output locally. A separate real Collector → Tempo/Prometheus stack received telemetry with 100% trace sampling and one-second metric exports. There were no paid provider calls.

The fixed corpus contained **106 synthetic documents and 136 chunks** across two organizations, digest `01a5a9b8ed414977187300b8ac56fcc62a5c7a87ecb2761ca44b5d4a1bc74eb5`. Embeddings were `resolvehub-synthetic-sha256-v1`, 64 dimensions; generation was `resolvehub-extractive-mock-v1`. Worker concurrency was two and the shared generation rate limit was ten requests/second. These results do not establish live-model performance or production capacity.

## Measured results

| Measurement                          | Result                                                                                                                          | Target/comparison                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Completed canonical drafts           | 30/30 at 10 concurrent k6 VUs; 150/150 checks                                                                                   | Every draft remained pending human approval and cited expected tenant evidence          |
| Draft end-to-end p50 / p95 / p99     | **927 / 961.85 / 969.97 ms**, maximum 972 ms                                                                                    | p95 ≤6000 ms: passed for this mock run                                                  |
| Draft variable AI cost               | $0 maximum and average                                                                                                          | ≤$0.02: passed for the explicitly free mock only                                        |
| Saturation requests                  | 1005 from 10 VUs in about 3.8 s, 267.80 requests/s                                                                              | Exactly **1000 accepted (202), 5 rejected (429)**; every rejection supplied Retry-After |
| Saturation admission p50 / p95 / p99 | 36.703 / 45.997 / 64.680 ms                                                                                                     | Admission measurement, not ingestion completion capacity                                |
| Saturation checks                    | 2010/2010; no unexpected HTTP failures                                                                                          | Queue was deliberately paused by the isolated harness                                   |
| Authoritative pending count          | PostgreSQL **1000**, Prometheus **1000** for the current worker instance                                                        | Real SQL → SDK → OTLP → Collector → scrape path verified                                |
| Trace propagation                    | Web → API/worker health; API → durable receipt → BullMQ producer/consumer → ingestion and drafting                              | Same initiating W3C trace retained across each flow                                     |
| Automatic dependency spans           | Real PostgreSQL and Redis child spans present                                                                                   | Startup order and ESM hook verified                                                     |
| Privacy                              | Supplied customer text, email, bearer token, object key, tenant ID, baggage and tracestate canaries absent from exported traces | No private canary observed in these measured traces                                     |

Draft latency starts immediately before `POST /v1/tickets/{id}/drafts` and ends after polling success and reading the pending draft through GraphQL. It includes queue scheduling, worker processing and polling, but excludes creating each synthetic ticket. Ten VUs each ran three drafts; it is a short burst, not a sustained throughput test. The queue saturation test pauses only the test-owned ingestion queue; it does not index 1000 documents or touch a developer queue. Thirty successful draft cases are not a remeasurement of the full milestone 06 quality evaluation.

The curated [machine-readable results](verification/milestone-08-metrics.json) preserve exact k6 metrics, environment, trace IDs and the operational snapshot. Full local k6 summaries, service logs and raw report live in ignored `test-results/`; they are regenerated on each run.

## Bottlenecks and limits

A representative measured drafting trace spent **13.906 ms** in RAG, including **0.125 ms** in synthetic embedding, **10.407 ms** in retrieval and **0.883 ms** in mock generation. Its consumer span lasted **29.850 ms**. These are one traced draft, not percentile estimates. Compared with the 927 ms median end-to-end latency, the likely dominant costs are the durable dispatch cadence (500 ms), bounded provider scheduling and client polling, rather than mock generation. Confirm with a sustained run and more queue-wait samples before changing concurrency or dispatch. No telemetry-disabled baseline was measured, so telemetry overhead is unknown.

The reported 267.80 requests/s measures admission with a paused queue, not document ingestion throughput. Successful-publication counters and stage spans are implemented, and one real MinIO ingestion was traced end-to-end, but sustained extraction/embedding/index publication capacity was not measured. Small exact tenant-filtered vector retrieval and mock generation cannot predict large-corpus or remote-provider behavior. p99 from 30 drafts has substantial sampling uncertainty. Docker Desktop, loopback networking and shared host resources also differ from production.

An exploratory run used the unrelated subject `Synthetic k6 support ticket` with the question only in the message. Its expected-answer/evidence check passed **2/30**, although HTTP execution and pending-draft checks succeeded. The existing conservative lexical relevance guard considers the subject as part of the question; an unrelated title can therefore suppress useful evidence. That failure remains a mock/RAG quality limitation. The final canonical benchmark uses the actual question as both subject and message, matching the established fixture benchmark, and changes no AI policy. Do not generalize its 30/30 result to arbitrary ticket titles. An earlier harness run also exposed too-short idempotency keys; the harness now uses valid prefixed keys.

No live provider latency/cost, sustained soak, cross-host trace propagation, production ingress sampling policy, failover or production rollout was measured. Integration tests separately reject sensitive exported payloads and verify successful mutations against an OTLP receiver returning 503. They do not establish long-outage telemetry durability; export buffers are intentionally finite.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm observability:up
pnpm observability:check
pnpm observability:verify
pnpm perf:run
```

`perf:run` builds production output, provisions disposable PostgreSQL/Redis/MinIO, migrates a clean database, creates distinct non-superuser API/worker logins, loads only deterministic synthetic fixtures and starts its own services on free ports. It downloads the official checksum-pinned k6 release, uses a mode-0600 temporary credential file, checks Tempo traces and Prometheus export, then removes its application processes, temporary credentials and containers. It never loads `.env` or calls a paid provider. The observability stack remains available for inspection; stop it with `pnpm observability:down` while retaining volumes.

Run `pnpm test:coverage` for PostgreSQL/Redis outage, transaction, retry, DLQ, index-preservation and telemetry privacy checks. See the [operations guide](operations/observability.md) for alert meanings and safe recovery. The final verification ledger records check counts and coverage separately.
