import { env } from '../../config/env';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './types';

/**
 * Hosted embeddings over the OpenAI-compatible embeddings API.
 *
 * OpenAI-compatible rather than OpenAI-specific: the endpoint is configurable,
 * so the same client works against OpenAI, Azure OpenAI, or any gateway
 * exposing that contract. Anthropic publishes no embeddings API, which is why
 * embeddings and generation use different providers here.
 *
 * `dimensions` is requested explicitly so the response matches the stored
 * column width. text-embedding-3-small supports reduction natively; without it
 * the model would return 1536 values and every insert would fail.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = env.embeddingModel;
  readonly semantic = true;

  /** Batched to keep request bodies reasonable and stay inside rate limits. */
  private static readonly BATCH_SIZE = 64;

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];

    for (let i = 0; i < texts.length; i += OpenAiEmbeddingProvider.BATCH_SIZE) {
      const batch = texts.slice(i, i + OpenAiEmbeddingProvider.BATCH_SIZE);
      out.push(...(await this.embedBatch(batch)));
    }

    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.embeddingTimeoutMs);

    try {
      const response = await fetch(`${env.embeddingBaseUrl}/embeddings`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.embeddingApiKey}`,
        },
        body: JSON.stringify({
          model: env.embeddingModel,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Embedding provider returned ${response.status}: ${body.slice(0, 200)}`);
      }

      const payload = (await response.json()) as {
        data?: { index: number; embedding: number[] }[];
      };
      if (!payload.data?.length) throw new Error('Embedding provider returned no vectors.');

      // The API does not guarantee response order, so results are placed by
      // their stated index rather than by array position.
      const ordered = new Array<number[]>(batch.length);
      for (const item of payload.data) {
        if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding provider returned ${item.embedding?.length} dimensions, expected ${EMBEDDING_DIMENSIONS}.`
          );
        }
        ordered[item.index] = item.embedding;
      }

      if (ordered.some((v) => !v)) throw new Error('Embedding provider returned an incomplete batch.');
      return ordered;
    } finally {
      clearTimeout(timeout);
    }
  }
}
