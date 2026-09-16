import { env } from '../../config/env';
import { loggerFor } from '../../observability/logger';
import { DeterministicEmbeddingProvider } from './deterministic.provider';
import { OpenAiEmbeddingProvider } from './openai.provider';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './types';

export { EMBEDDING_DIMENSIONS };
export type { EmbeddingProvider };

const log = loggerFor('embeddings');
const deterministic = new DeterministicEmbeddingProvider();

function selectProvider(): EmbeddingProvider {
  if (env.embeddingProvider === 'openai') {
    if (!env.embeddingApiKey) {
      log.warn('EMBEDDING_PROVIDER=openai but EMBEDDING_API_KEY is empty - using deterministic');
      return deterministic;
    }
    return new OpenAiEmbeddingProvider();
  }
  return deterministic;
}

const provider = selectProvider();

export const embeddingStatus = {
  configured: env.embeddingProvider,
  active: provider.name,
  semantic: provider.semantic,
  dimensions: EMBEDDING_DIMENSIONS,
};

export interface EmbeddingOutcome {
  vectors: number[][];
  model: string;
  usedFallback: boolean;
}

/**
 * Embeds text, degrading to the offline provider on any failure.
 *
 * Mirrors the AI and WhatsApp layers deliberately: a provider outage must
 * reduce retrieval quality, never remove the feature. The outcome reports which
 * engine ran so the caller can record it rather than guess.
 */
export async function embed(texts: string[]): Promise<EmbeddingOutcome> {
  if (texts.length === 0) return { vectors: [], model: provider.name, usedFallback: false };

  if (provider === deterministic) {
    return { vectors: await deterministic.embed(texts), model: deterministic.name, usedFallback: true };
  }

  try {
    return { vectors: await provider.embed(texts), model: provider.name, usedFallback: false };
  } catch (error) {
    log.warn({ err: (error as Error).message }, 'embedding failed - using deterministic fallback');
    return {
      vectors: await deterministic.embed(texts),
      model: deterministic.name,
      usedFallback: true,
    };
  }
}

/** pgvector accepts a vector literal as '[0.1,0.2,...]'. */
export const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;
