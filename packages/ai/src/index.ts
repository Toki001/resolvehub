export interface DraftInput {
  organizationId: string;
  question: string;
  evidence: ReadonlyArray<{ chunkId: string; text: string }>;
}

export interface DraftResult {
  kind: 'insufficient_evidence';
  text: string;
  citations: readonly string[];
  provider: 'mock';
}

export interface DraftProvider {
  draft(input: DraftInput): Promise<DraftResult>;
}

// Deliberately abstains until retrieval and citation validation are implemented.
// No external network calls, fabricated evidence, or claimed confidence scores.
export class MockDraftProvider implements DraftProvider {
  async draft(_input: DraftInput): Promise<DraftResult> {
    return {
      kind: 'insufficient_evidence',
      text: 'Evidence-grounded drafting is not configured.',
      citations: [],
      provider: 'mock',
    };
  }
}

export {
  SyntheticEmbeddingProvider,
  syntheticEmbedding,
  SYNTHETIC_MODEL,
  SYNTHETIC_DIMENSIONS,
} from './embedding.js';
export type { EmbeddingProvider } from './embedding.js';
