export {
  SyntheticEmbeddingProvider,
  syntheticEmbedding,
  SYNTHETIC_MODEL,
  SYNTHETIC_DIMENSIONS,
} from './embedding.js';
export type { EmbeddingProvider } from './embedding.js';

export { EmbeddingProviderError } from './provider-error.js';

export * from './drafting/config.js';
export * from './drafting/evidence.js';
export * from './drafting/provider.js';
export * from './drafting/pipeline.js';
export * from './gemini/config.js';
export * from './gemini/provider.js';
