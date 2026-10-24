# Milestone 12: exhaustive branch audit

Source: the actual Jest `coverage/coverage-final.json`, `coverage/coverage-summary.json`, HTML report and LCOV output. Baseline was captured before edits; final data is from the verified run. Paths are relative and contain no credentials.

The baseline reports **92.33%** (1216/1317), with **101 uncovered branch ranges**. The updated report is **97.84%** (1361/1391), with **30 uncovered ranges**. V8 discovers additional nested ranges when previously untouched code executes, so the branch denominator/IDs can change without production edits. No coverage exclusions, provider/model changes or lowered thresholds were made.

“Overall” means the existing critical-service coverage selection, not every production file in the monorepo. Web, transport, telemetry and other modules outside that selection remain outside the percentage; browser/contracts/integration tests still exercise those boundaries. Independent critical-area 80% gates remain; a new actual-total 95% gate runs after Jest because Jest subtracts directory threshold groups from its global group.

## Every baseline uncovered branch, grouped by file and risk

### packages/ai/src/drafting/config.ts

| Branch | Source range (line:column) | Risk                                       | Uncovered expression/range                        |
| ------ | -------------------------- | ------------------------------------------ | ------------------------------------------------- |
| 25.0   | 63:6–63:55                 | Low — deterministic/configuration fallback | throw new Error('Ollama model must be explicit'); |

### packages/ai/src/drafting/evidence.ts

| Branch | Source range (line:column) | Risk                       | Uncovered expression/range                                        |
| ------ | -------------------------- | -------------------------- | ----------------------------------------------------------------- |
| 1.0    | 20:60–20:66                | High — retrieval/citations | const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) |

### packages/ai/src/drafting/pipeline.ts

| Branch | Source range (line:column) | Risk                       | Uncovered expression/range                                              |
| ------ | -------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| 47.0   | 265:8–265:19               | High — retrieval/citations | : undefined;                                                            |
| 57.0   | 272:8–272:79               | High — retrieval/citations | throw new DraftingFailure('RAG_CONTEXT_FAILED', position.stage, false); |
| 59.0   | 274:5–274:15               | High — retrieval/citations | } finally {                                                             |
| 70.0   | 122:16–122:39              | High — retrieval/citations | : 'operator_configured',                                                |

### packages/ai/src/drafting/provider.ts

| Branch | Source range (line:column) | Risk                                       | Uncovered expression/range                                                                 |
| ------ | -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 9.0    | 38:44–38:90                | Low — deterministic/configuration fallback | options.sort((a, b) => b.score - a.score \|\| a.row.chunkId.localeCompare(b.row.chunkId)); |

### packages/ai/src/gemini/config.ts

| Branch | Source range (line:column) | Risk                                | Uncovered expression/range                                                         |
| ------ | -------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| 8.0    | 52:10–52:50                | High — provider/free-tier admission | : Number(env.GEMINI_REQUESTS_PER_MINUTE),                                          |
| 12.0   | 56:57–56:89                | High — provider/free-tier admission | env.GEMINI_CONCURRENCY === undefined ? undefined : Number(env.GEMINI_CONCURRENCY), |

### packages/ai/src/gemini/discovery.ts

| Branch | Source range (line:column) | Risk                                | Uncovered expression/range                                            |
| ------ | -------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| 14.0   | 47:12–47:62                | High — provider/free-tier admission | throw new GeminiFailure('GEMINI_DISCOVERY_LIMIT');                    |
| 17.0   | 54:23–54:79                | High — provider/free-tier admission | if (!reader) throw new GeminiFailure('GEMINI_DISCOVERY_UNAVAILABLE'); |

### packages/ai/src/gemini/provider.ts

| Branch | Source range (line:column) | Risk                                | Uncovered expression/range                                       |
| ------ | -------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| 26.0   | 160:53–160:59              | High — provider/free-tier admission | (result.usageMetadata?.candidatesTokenCount ?? -1) +             |
| 32.0   | 166:35–166:41              | High — provider/free-tier admission | const text = (result.text ?? '').trim();                         |
| 42.0   | 184:16–184:34              | High — provider/free-tier admission | ? 'GEMINI_TIMEOUT'                                               |
| 43.0   | 186:18–186:44              | High — provider/free-tier admission | ? 'GEMINI_INVALID_REQUEST'                                       |
| 44.0   | 189:20–193:46              | High — provider/free-tier admission | : status === 404 ? 'GEMINI_MODEL_UNAVAILABLE' : status === 429   |
| 47.0   | 201:5–201:15               | High — provider/free-tier admission | } finally {                                                      |
| 50.0   | 78:14–78:65                | High — provider/free-tier admission | throw new GeminiFailure('GEMINI_ENDPOINT_BLOCKED');              |
| 64.0   | 99:25–99:76                | High — provider/free-tier admission | if (!reader) throw new GeminiFailure('GEMINI_INVALID_RESPONSE'); |
| 76.0   | 137:28–137:36              | High — provider/free-tier admission | if (signal.aborted) abort();                                     |

### packages/db/src/drafting.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                                                       |
| ------ | -------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| 7.0    | 69:6–73:5                  | High — tenant/data integrity | } catch (error) { client.removeListener('error', onError); client.release(true); |
| 25.0   | 143:17–143:54              | High — tenant/data integrity | if (!result) throw new Error('Usage unavailable');                               |
| 43.0   | 240:15–240:23              | High — tenant/data integrity | stage ?? null,                                                                   |
| 48.0   | 271:6–273:5                | High — tenant/data integrity | } catch { discard = true; }                                                      |

### packages/db/src/ingestion.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                                                               |
| ------ | -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------- |
| 10.0   | 94:6–98:5                  | High — tenant/data integrity | } catch (error) { client.removeListener('error', connectionError); client.release(true); |
| 17.0   | 125:8–125:31               | High — tenant/data integrity | return 'skip' as const;                                                                  |
| 25.0   | 163:23–163:40              | High — tenant/data integrity | if (!rows.rows[0]) return undefined;                                                     |
| 63.0   | 264:8–264:21               | High — tenant/data integrity | return false;                                                                            |
| 85.0   | 352:6–354:5                | High — tenant/data integrity | } catch { discard = true; }                                                              |

### packages/db/src/knowledge.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                                                                      |
| ------ | -------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| 5.0    | 82:76–82:82                | High — tenant/data integrity | const words = [...new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 64))]; |
| 18.0   | 155:64–155:97              | High — tenant/data integrity | if (!previous \|\| previous.revision >= version.revision) throw new StoreConflict('state');     |
| 25.0   | 226:21–226:58              | High — tenant/data integrity | if (!document) throw new StoreConflict('not_found');                                            |
| 26.0   | 238:20–238:57              | High — tenant/data integrity | if (!version) throw new StoreConflict('not_found');                                             |
| 27.0   | 239:29–239:36              | High — tenant/data integrity | if (version.deletedAt) return;                                                                  |
| 29.0   | 271:54–271:91              | High — tenant/data integrity | if (actor.organizationId !== this.organizationId) throw new StoreConflict('not_found');         |

### packages/db/src/store.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                                                                   |
| ------ | -------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| 14.0   | 112:19–112:65              | High — tenant/data integrity | if (!record) throw new Error('Missing idempotency record');                                  |
| 23.0   | 131:5–131:15               | High — tenant/data integrity | } finally {                                                                                  |
| 35.0   | 172:20–172:28              | High — tenant/data integrity | filter.query ?? null,                                                                        |
| 50.0   | 254:31–254:64              | High — tenant/data integrity | if (result.rowCount !== 1) throw new StoreConflict('state');                                 |
| 62.0   | 312:17–312:28              | High — tenant/data integrity | page.last?.createdAt ?? null,                                                                |
| 63.0   | 313:17–313:21              | High — tenant/data integrity | page.last?.id ?? null,                                                                       |
| 66.0   | 329:17–329:28              | High — tenant/data integrity | page.last?.createdAt ?? null,                                                                |
| 67.0   | 330:17–330:21              | High — tenant/data integrity | page.last?.id ?? null,                                                                       |
| 77.0   | 387:31–387:39              | High — tenant/data integrity | if ((pending.rows[0]?.count ?? 1000) >= 1000) throw new StoreConflict('capacity');           |
| 91.0   | 481:14–481:51              | High — tenant/data integrity | if (!job) throw new StoreConflict('not_found');                                              |
| 92.0   | 482:33–482:66              | High — tenant/data integrity | if (job.status !== 'failed') throw new StoreConflict('state');                               |
| 97.0   | 493:27–493:60              | High — tenant/data integrity | if (denied.rowCount) throw new StoreConflict('state');                                       |
| 100.0  | 500:29–500:62              | High — tenant/data integrity | if (!failure.rowCount) throw new StoreConflict('state');                                     |
| 101.0  | 509:29–509:62              | High — tenant/data integrity | if (!version.rowCount) throw new StoreConflict('state');                                     |
| 104.0  | 529:54–529:96              | High — tenant/data integrity | if (actor.organizationId !== this.organizationId) throw new Error('Audit context mismatch'); |
| 106.0  | 554:17–554:28              | High — tenant/data integrity | page.last?.createdAt ?? null,                                                                |
| 107.0  | 555:17–555:21              | High — tenant/data integrity | page.last?.id ?? null,                                                                       |
| 110.0  | 576:17–576:28              | High — tenant/data integrity | page.last?.createdAt ?? null,                                                                |
| 111.0  | 577:17–577:21              | High — tenant/data integrity | page.last?.id ?? null,                                                                       |

### packages/db/src/tenant.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range |
| ------ | -------------------------- | ---------------------------- | -------------------------- |
| 4.0    | 23:3–23:13                 | High — tenant/data integrity | } finally {                |

### services/api/src/application/ai-status.service.ts

| Branch | Source range (line:column) | Risk                                | Uncovered expression/range                                                                      |
| ------ | -------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| 3.0    | 28:10–30:35                | High — provider/free-tier admission | : this.env.DRAFT_PROVIDER === 'mock' ? 'resolvehub-extractive-mock-v1' : 'operator-configured', |
| 9.0    | 45:8–45:27                 | High — provider/free-tier admission | return unavailable;                                                                             |
| 18.0   | 70:36–70:42                | High — provider/free-tier admission | ].includes(status.reasonCode ?? '')                                                             |
| 19.0   | 72:10–72:15                | High — provider/free-tier admission | : 503,                                                                                          |
| 20.0   | 73:25–73:49                | High — provider/free-tier admission | status.reasonCode ?? 'GEMINI_UNAVAILABLE',                                                      |
| 21.0   | 75:83–75:94                | High — provider/free-tier admission | status.retryAfterSeconds ? { retryAfterSeconds: status.retryAfterSeconds } : undefined,         |

### services/api/src/application/support.service.ts

| Branch | Source range (line:column) | Risk                               | Uncovered expression/range                                                       |
| ------ | -------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| 7.0    | 69:8–69:88                 | Medium — transport/data validation | throw new ApiFault(500, 'INTERNAL_ERROR', 'Stored data violated its contract.'); |
| 90.0   | 339:70–339:83              | Medium — transport/data validation | status: z.enum(['pending', 'approved', 'rejected']).parse(status ?? 'pending'),  |
| 123.0  | 468:44–468:50              | Medium — transport/data validation | const parsed = filterSchema.parse(filter ?? {});                                 |
| 124.0  | 470:24–470:51              | Medium — transport/data validation | ...(parsed.status ? { status: parsed.status } : {}),                             |
| 125.0  | 471:49–471:53              | Medium — transport/data validation | ...(parsed.query ? { query: parsed.query } : {}),                                |

### services/api/src/application/validator.ts

| Branch | Source range (line:column) | Risk                               | Uncovered expression/range      |
| ------ | -------------------------- | ---------------------------------- | ------------------------------- |
| 6.0    | 40:32–40:38                | Medium — transport/data validation | fields: (validate.errors ?? []) |

### services/api/src/auth/crypto.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                               |
| ------ | -------------------------- | ---------------------------- | -------------------------------------------------------- |
| 11.0   | 18:46–18:56                | High — authorization/secrets | tokenDigest(JSON.stringify(canonical(value)) ?? 'null'); |
| 16.0   | 43:4–43:44                 | High — authorization/secrets | throw new Error('Invalid sealed value');                 |

### services/api/src/auth/webhook-auth.service.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range       |
| ------ | -------------------------- | ---------------------------- | -------------------------------- |
| 5.0    | 44:6–46:5                  | High — authorization/secrets | } catch { throw unavailable(); } |
| 9.0    | 56:6–58:5                  | High — authorization/secrets | } catch { throw unavailable(); } |

### services/worker/src/drafting/gemini-budget.ts

| Branch | Source range (line:column) | Risk                                | Uncovered expression/range                                                  |
| ------ | -------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| 4.0    | 42:21–42:58                | High — provider/free-tier admission | if (eligibility) throw new GeminiFailure(eligibility);                      |
| 37.0   | 149:16–149:22              | High — provider/free-tier admission | .exec()) ?? [];                                                             |
| 45.0   | 167:12–167:35              | High — provider/free-tier admission | ? 'GEMINI_MINUTE_LIMIT'                                                     |
| 72.0   | 151:32–151:79              | High — provider/free-tier admission | if (!result \|\| result[0]) throw new Error('Provider status unavailable'); |

### services/worker/src/drafting/processor.ts

| Branch | Source range (line:column) | Risk                              | Uncovered expression/range                                                        |
| ------ | -------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| 27.0   | 146:69–146:92              | High — worker failure/publication | stage === 'persistence' ? 'DRAFT_PERSISTENCE_FAILED' : 'DRAFT_WORKER_FAILED',     |
| 38.0   | 52:8–54:7                  | High — worker failure/publication | } catch { throw new DraftingFailure('DRAFT_PERSISTENCE_FAILED', 'persistence'); } |
| 40.0   | 61:49–61:62                | High — worker failure/publication | const activeTraceId = trace.getActiveSpan()?.spanContext().traceId ?? '';         |
| 42.0   | 63:48–63:54                | High — worker failure/publication | ? (session.job.traceparent.split('-')[1] ?? '')                                   |
| 44.0   | 66:44–66:75                | High — worker failure/publication | /^[a-f0-9]{32}$/.test(activeTraceId) && !/^0+$/.test(activeTraceId)               |
| 45.0   | 67:10–67:25                | High — worker failure/publication | ? activeTraceId                                                                   |

### services/worker/src/drafting/runtime.ts

| Branch | Source range (line:column) | Risk                        | Uncovered expression/range                                                   |
| ------ | -------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| 4.0    | 56:8–56:41                 | Medium — dispatch/lifecycle | : new OllamaDraftProvider(config);                                           |
| 15.0   | 111:28–111:35              | Medium — dispatch/lifecycle | if (stopped \|\| pending) return;                                            |
| 19.0   | 118:61–118:76              | Medium — dispatch/lifecycle | mode: config.provider === 'mock' ? 'synthetic' : 'unavailable',              |
| 20.0   | 128:18–128:87              | Medium — dispatch/lifecycle | : 'Local Ollama is configured; cloud provider status is unavailable.',       |
| 24.0   | 147:20–147:83              | Medium — dispatch/lifecycle | if (existing && ['completed', 'failed'].includes(await existing.getState())) |
| 25.0   | 148:10–148:34              | Medium — dispatch/lifecycle | await existing.remove();                                                     |

### services/worker/src/ingestion/extract.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                                                        |
| ------ | -------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| 12.0   | 34:4–34:53                 | Medium — untrusted documents | throw new IngestionFailure('INVALID_TYPE', true);                                 |
| 23.0   | 58:27–58:79                | Medium — untrusted documents | if (chunks.length > 256) throw new IngestionFailure('INVALID_CONTENT', true);     |
| 27.0   | 64:26–67:7                 | Medium — untrusted documents | if (signal.aborted) { reject(new IngestionFailure('EXTRACTION_TIMEOUT')); return; |
| 29.0   | 80:-1–80:67                | Medium — untrusted documents | else reject(new IngestionFailure('INVALID_CONTENT', true));                       |

### services/worker/src/ingestion/limiter.ts

| Branch | Source range (line:column) | Risk                     | Uncovered expression/range                                                     |
| ------ | -------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| 9.0    | 22:36–22:84                | High — bounded admission | if (typeof wait !== 'number') throw new IngestionFailure('REDIS_UNAVAILABLE'); |
| 13.0   | 26:-1–27:3                 | High — bounded admission | throw new IngestionFailure('WORKER_INTERRUPTED'); }                            |

### services/worker/src/ingestion/pdf-parser.ts

| Branch | Source range (line:column) | Risk                         | Uncovered expression/range                                                                                                   |
| ------ | -------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0.0    | 1:0–28:75                  | Medium — untrusted documents | import { parentPort, workerData } from 'node:worker_threads'; import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'; |

### services/worker/src/ingestion/processor.ts

| Branch | Source range (line:column) | Risk                              | Uncovered expression/range                                                       |
| ------ | -------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| 10.0   | 46:38–46:45                | High — worker failure/publication | if (dependencies.signal?.aborted) stop();                                        |
| 15.0   | 52:28–52:35                | High — worker failure/publication | if (claim === 'skip') return;                                                    |
| 36.0   | 145:37–145:86              | High — worker failure/publication | if (controller.signal.aborted) throw new IngestionFailure('WORKER_INTERRUPTED'); |

### services/worker/src/ingestion/runtime.ts

| Branch | Source range (line:column) | Risk                        | Uncovered expression/range                                                                                                           |
| ------ | -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0    | 20:54–20:60                | Medium — dispatch/lifecycle | ) => (error instanceof RetryIngestion ? error.delayMs : 1000);                                                                       |
| 5.0    | 44:18–47:5                 | Medium — dispatch/lifecycle | if (existing) { const state = await existing.getState(); if (state === 'completed' \|\| state === 'failed') await existing.remove(); |
| 7.0    | 74:6–77:5                  | Medium — dispatch/lifecycle | } catch (error) { await client.query('ROLLBACK'); throw error;                                                                       |
| 16.0   | 152:28–152:35              | Medium — dispatch/lifecycle | if (stopped \|\| pending) return;                                                                                                    |

## Every remaining uncovered branch and disposition

Reachable gaps are explicitly identified as follow-up work. A branch is not labeled unreachable merely because a test is difficult. High-risk defensive guards are retained in the denominator. No claim is made that passing coverage proves absence of security defects.

### packages/ai/src/drafting/pipeline.ts

- **60.0, 274:5–274:15; High — retrieval/citations.** V8 reports the finally boundary as a separate empty range. Success, invalid citations, retrieval/context/generation failure, timeout and cancellation tests execute cleanup; retained as an instrumentation gap, not excluded.

### packages/ai/src/gemini/discovery.ts

- **11.0, 101:6–101:57; High — provider/free-tier admission.** Generic network/SDK exception sanitization during read-only model discovery is reachable and remains a follow-up. HTTP failures, missing/oversized bodies, account eligibility and the strict three-page bound are tested. Generation transport failures are independently tested; this metadata-only fallback is not claimed unreachable.

### packages/ai/src/gemini/provider.ts

- **42.0, 184:16–184:34; High — provider/free-tier admission.** Generic-error + aborted-signal fallback is not separately reached: the bounded abort race normally produces a typed GeminiFailure first. Both cooperative and uncooperative timeout tests assert failure/lease release. No fake SDK internals added to force race ordering.

- **55.0, 201:5–201:15; High — provider/free-tier admission.** V8 finally-boundary range. Tests explicitly assert lease release on success, HTTP failures, timeouts, malformed body and persistence checkpoint failure. Still reported, not removed from denominator.

- **58.0, 78:14–78:65; High — provider/free-tier admission.** SDK endpoint allowlist denial is defensive: the official SDK is given a constant origin, API version, model and POST method. Reaching denial requires replacing/mutating SDK internals. Tests inspect the actual SDK-generated URL/method and forbid paid features; guard retained.

### packages/db/src/drafting.ts

- **27.0, 143:17–143:54; High — tenant/data integrity.** PostgreSQL aggregate without GROUP BY always returns one row, including an empty attempt set. DB exceptions are tested. Returning zero rows would require replacing database semantics or the query.

### packages/db/src/store.ts

- **14.0, 112:19–112:65; High — tenant/data integrity.** The idempotency row is inserted then locked/read in the same transaction; the unique constraint serializes competing writers. A missing row requires privileged trigger/corruption outside supported behavior. Existing tests cover concurrent reuse, conflicts and rollback.

- **23.0, 131:5–131:15; High — tenant/data integrity.** V8 finally-boundary range, with successful, conflicting and rolled-back mutations tested against real PostgreSQL. Connection release is exercised, not excluded.

- **83.0, 387:31–387:39; High — tenant/data integrity.** ingestion_pending_count() is an aggregate function returning one numeric row. Missing-row fallback is defensive; real 1,000-item saturation and concurrent admission tests cover capacity denial.

### packages/db/src/tenant.ts

- **4.0, 23:3–23:13; High — tenant/data integrity.** V8 finally-boundary range. RLS context/no-context and pooled context cleanup/rollback tests run against PostgreSQL; no exclusion added.

### services/api/src/application/ai-status.service.ts

- **3.0, 28:10–30:35; High — provider/free-tier admission.** Reachable non-Gemini fallback identity (mock/Ollama) not separately exercised here. Synthetic runtime and Gemini heartbeat behavior are covered; local-provider fallback display remains a low-risk gap.

### services/api/src/application/support.service.ts

- **90.0, 339:70–339:83; Medium — transport/data validation.** Public-service optional status default is reachable directly, but the GraphQL SDL supplies pending before resolver invocation. Current dashboard/API review behavior is covered; direct-call default remains a low-risk gap.

### services/api/src/application/validator.ts

- **6.0, 40:32–40:38; Medium — transport/data validation.** AJV populates errors when synchronous validation returns false. Null-error fallback requires a substituted/malformed validator implementation; request validation and response rejection already tested.

### services/worker/src/drafting/gemini-budget.ts

- **38.0, 149:16–149:22; High — provider/free-tier admission.** Redis EXEC can return null after a watched-key conflict; this implementation never WATCHes. No WATCH means normal EXEC returns results or throws. Real WRONGTYPE results and disconnection fail closed in tests.

### services/worker/src/drafting/processor.ts

- **44.0, 61:49–61:62; High — worker failure/publication.** Active-span optional fallback remains an operational diagnostics gap; stored trace correlation, sanitized diagnostics and logger failure are tested. No tenant/customer data is introduced to labels.

- **46.0, 63:48–63:54; High — worker failure/publication.** validTraceparent() already guarantees a trace ID segment, so split()[1] cannot be undefined on this branch. Forging the validator would mock the behavior being verified.

- **48.0, 66:44–66:75; High — worker failure/publication.** Alternate active-trace validity path remains an operational diagnostics gap. Existing trace propagation/privacy suites and stored correlation run; no claim of complete trace-branch coverage.

- **49.0, 67:10–67:25; High — worker failure/publication.** Choosing active trace over stored trace is reachable but not separately forced in the worker suite. Stored trace fallback is tested. Lower risk than authorization/publication/retry behavior; retained follow-up.

### services/worker/src/drafting/runtime.ts

- **4.0, 56:8–56:41; Medium — dispatch/lifecycle.** Existing local Ollama runtime selection is outside the active Gemini/synthetic deployment. Adapter has offline tests; no local server or paid service is started to increase coverage.

- **15.0, 111:28–111:35; Medium — dispatch/lifecycle.** Overlapping/stopped scheduler tick is reachable under timing/load. Runtime readiness/shutdown and dispatch are tested; this exact short-circuit remains a lifecycle follow-up.

- **19.0, 118:61–118:76; Medium — dispatch/lifecycle.** Existing Ollama heartbeat unavailable branch not exercised at runtime; no automatic provider switching enabled. Offline adapter tests remain.

- **20.0, 128:18–128:87; Medium — dispatch/lifecycle.** Existing Ollama-only status message; same deferred runtime branch, not active Gemini policy.

- **24.0, 147:20–147:83; Medium — dispatch/lifecycle.** Removal of a retained completed/failed Redis job before redispatch is reachable and remains a medium-risk recovery follow-up. Current suite tests duplicate publication, durable interrupted claims, four retries and DLQ replay; this distinct cleanup path is not claimed covered.

- **25.0, 148:10–148:34; Medium — dispatch/lifecycle.** Same retained Redis terminal-job cleanup path; reachable, deferred, not classified unreachable.

### services/worker/src/ingestion/extract.ts

- **24.0, 58:27–58:79; Medium — untrusted documents.** normalizeText caps text at 200,000 characters; 1,000-character chunks advancing 900 produce at most 223 chunks. The >256 guard is unreachable with current constants. Length limits and actual chunk overlap are tested.

### services/worker/src/ingestion/limiter.ts

- **8.0, 22:36–22:84; High — bounded admission.** The fixed Redis Lua script returns numeric PTTL or literal zero; nonnumeric output would require replacing the script/Redis implementation. Real downtime, shared limits and cancellation tests cover operational failures.

### services/worker/src/ingestion/pdf-parser.ts

- **0.0, 1:0–28:75; Medium — untrusted documents.** The real parser executes in a Node worker thread, outside Jest V8 coverage collection. Valid PDF indexing and corrupt-PDF rejection execute it. This entire file remains included at zero rather than falsely claiming coverage; page/text/resource cap internals are not separately measured.

### services/worker/src/ingestion/runtime.ts

- **1.0, 20:54–20:60; Medium — dispatch/lifecycle.** Default BullMQ backoff for an unknown error is reachable and remains a low-risk gap. Actual RetryIngestion delays and provider Retry-After/exhaustion are tested.

- **7.0, 46:55–46:79; Medium — dispatch/lifecycle.** Removal of a retained completed/failed Redis job before redispatch is reachable and remains a medium-risk recovery follow-up. New tests cover acknowledgement rollback and deduplicating an existing waiting job. Existing retry/exhaustion/DLQ suites do not substitute for testing this distinct terminal cleanup path.

- **20.0, 152:28–152:35; Medium — dispatch/lifecycle.** Scheduler overlapping/stopped tick remains a timing-dependent lifecycle gap. Startup, readiness and clean close are verified.
