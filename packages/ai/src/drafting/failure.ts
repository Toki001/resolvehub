export const draftingStages = [
  'source',
  'retrieval',
  'context',
  'generation',
  'response_parsing',
  'citation_validation',
  'persistence',
  'complete',
] as const;
export type DraftingStage = (typeof draftingStages)[number];
export type DraftingProgress = (stage: DraftingStage) => Promise<void>;

// Fixed categories only: never preserve dependency messages, SQL or model text.
export class DraftingFailure extends Error {
  constructor(
    readonly category:
      | 'RAG_RETRIEVAL_FAILED'
      | 'RAG_CONTEXT_FAILED'
      | 'DRAFT_PERSISTENCE_FAILED'
      | 'DRAFT_WORKER_FAILED'
      | 'DRAFT_TIMEOUT',
    readonly stage: DraftingStage,
    readonly transient = true,
  ) {
    super(category);
    this.name = 'DraftingFailure';
  }
}
