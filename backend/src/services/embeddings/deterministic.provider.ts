import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './types';

/**
 * Offline embedding provider — hashed bag-of-words.
 *
 * IMPORTANT, and stated plainly because it would be dishonest to imply
 * otherwise: this is NOT a semantic embedding. Each token is hashed into one of
 * 384 buckets and weighted by frequency, which makes it a compressed lexical
 * representation. Cosine similarity over these vectors therefore measures word
 * overlap, not meaning — "refund" and "reimbursement" are unrelated to it.
 *
 * It exists for the same reason the rule-based AI provider does: the system
 * must be runnable, testable and demonstrable with no API key and no network,
 * and retrieval must degrade rather than disappear. Every retrieval records
 * which provider produced it, so quality claims stay honest.
 *
 * Deterministic by construction, which also makes retrieval tests stable.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'deterministic-lexical';
  readonly semantic = false;

  /** Lowercase word tokens, dropping very common words that carry no signal. */
  private tokenise(text: string): string[] {
    const STOP = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
      'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'my', 'i', 'it',
      'this', 'that', 'as', 'from', 'by', 'you', 'your', 'we', 'our',
    ]);
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t));
  }

  /** Stable bucket for a token, from the first 4 bytes of its SHA-1. */
  private bucket(token: string): number {
    const digest = createHash('sha1').update(token).digest();
    return digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = this.tokenise(text);

    for (const token of tokens) {
      // Sub-linear term weighting, so a word repeated ten times does not
      // dominate a passage the way raw counts would.
      vector[this.bucket(token)] += 1;
    }
    for (let i = 0; i < vector.length; i += 1) {
      if (vector[i] > 0) vector[i] = 1 + Math.log(vector[i]);
    }

    // L2 normalisation, so cosine distance depends on direction rather than
    // passage length — otherwise long chunks would always look more relevant.
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vector;
    return vector.map((v) => v / magnitude);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}
