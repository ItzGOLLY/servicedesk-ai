/**
 * Fixed across every provider, because it is the stored column width in
 * kb_chunks.embedding. Changing it requires a migration and full re-indexing.
 */
export const EMBEDDING_DIMENSIONS = 384;

export interface EmbeddingProvider {
  readonly name: string;
  /** True when vectors are computed locally and are lexical, not semantic. */
  readonly semantic: boolean;
  /** Embeds a batch. Order of the result matches the order of the input. */
  embed(texts: string[]): Promise<number[][]>;
}
