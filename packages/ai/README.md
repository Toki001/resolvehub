# AI support drafting

`DraftingPipeline` embeds the authenticated ticket query, retrieves published tenant evidence through an injected repository, optionally reranks it, bounds the prompt, calls an injected generation adapter, validates every quotation and immutable source identifier, and renders references. Empty, unsafe or unsupported evidence returns an explicit abstention. No component sends a message.

`ExtractiveMockProvider` is deterministic and has no network calls or golden-case lookup. `OllamaDraftProvider` implements bounded structured generation through `/api/generate`; returned usage and model identity are validated. The pipeline accepts exact source quotations, rather than arbitrary generated claims that cannot be verified mechanically. Human review remains necessary.

The 64-dimensional embedding model is explicitly synthetic and stays compatible with stored indexes. Hybrid PostgreSQL full-text candidates compensate for its nonsemantic vectors; the evaluator reports both hybrid Recall@5 and the raw vector baseline. Changing the embedding model/dimensions requires a reindex and explicit migration.

Use `pnpm ai:eval` to measure the checked-in 30 answerable, 20 insufficient and 10 adversarial/cross-tenant cases against isolated pgvector, with ten concurrent requests. Results and denominators are written to `test-results/ai-evaluation.json`. `pnpm test:coverage` also measures actual API/queue/worker/poll latency and enforces the golden evaluation. Read [operations](../../docs/operations/ai-drafting.md) before enabling a local model or interpreting mock scores.
