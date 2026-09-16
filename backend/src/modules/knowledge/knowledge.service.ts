import { query, queryOne, withTransaction } from '../../db/pool';
import { loggerFor } from '../../observability/logger';
import { embed, toVectorLiteral } from '../../services/embeddings';

const log = loggerFor('knowledge');

/**
 * Knowledge-base indexing and retrieval.
 *
 * Articles are written by staff; this module turns them into retrievable
 * passages and finds the ones relevant to a ticket.
 */

/**
 * Target passage size in characters.
 *
 * Chosen to be large enough to contain a complete answer to one question and
 * small enough that several can be supplied to the model without crowding the
 * context. Splitting happens on paragraph then sentence boundaries so a chunk
 * does not begin mid-thought.
 */
const TARGET_CHUNK_CHARS = 700;
const CHUNK_OVERLAP_CHARS = 100;
const MIN_CHUNK_CHARS = 60;

/**
 * Splits an article into overlapping passages.
 *
 * The overlap matters: without it, a sentence that straddles a boundary is
 * split across two chunks and neither contains the whole answer.
 */
export function chunkArticle(title: string, body: string): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length >= MIN_CHUNK_CHARS) chunks.push(trimmed);
    else if (trimmed && chunks.length) chunks[chunks.length - 1] += `\n\n${trimmed}`;
    else if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const paragraph of paragraphs) {
    // A paragraph longer than the target is split further on sentence ends.
    if (paragraph.length > TARGET_CHUNK_CHARS) {
      flush();
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length > TARGET_CHUNK_CHARS && current) {
          const tail = current.slice(-CHUNK_OVERLAP_CHARS);
          flush();
          current = `${tail} `;
        }
        current += `${sentence} `;
      }
      flush();
      continue;
    }

    if (current.length + paragraph.length > TARGET_CHUNK_CHARS && current) flush();
    current += `${current ? '\n\n' : ''}${paragraph}`;
  }
  flush();

  // The title is prepended to every chunk. Retrieval matches against passage
  // text alone, so without this a passage that never repeats the subject (for
  // example "Wait three to five working days.") is unfindable.
  return chunks.map((c) => `${title}\n\n${c}`);
}

/**
 * Re-chunks and re-embeds one article.
 *
 * Chunks are replaced wholesale rather than diffed: articles are short and
 * edited rarely, so a delete-and-insert inside one transaction is simpler and
 * cannot leave the index half-updated.
 */
export async function indexArticle(articleId: string): Promise<{ chunks: number; model: string }> {
  const article = await queryOne<{ title: string; body: string }>(
    'SELECT title, body FROM kb_articles WHERE id = $1',
    [articleId]
  );
  if (!article) return { chunks: 0, model: 'none' };

  const pieces = chunkArticle(article.title, article.body);
  if (pieces.length === 0) return { chunks: 0, model: 'none' };

  const outcome = await embed(pieces);

  await withTransaction(async (client) => {
    await client.query('DELETE FROM kb_chunks WHERE article_id = $1', [articleId]);

    for (let i = 0; i < pieces.length; i += 1) {
      await client.query(
        `INSERT INTO kb_chunks (article_id, chunk_index, content, embedding, embedding_model, embedded_at)
         VALUES ($1, $2, $3, $4::vector, $5, NOW())`,
        [articleId, i, pieces[i], toVectorLiteral(outcome.vectors[i]), outcome.model]
      );
    }
  });

  log.info({ articleId, chunks: pieces.length, model: outcome.model }, 'article indexed');
  return { chunks: pieces.length, model: outcome.model };
}

export interface RetrievedChunk {
  chunkId: string;
  articleId: string;
  articleTitle: string;
  content: string;
  /** 0–1, where 1 is identical. Derived from pgvector's cosine distance. */
  score: number;
}

export interface RetrievalOutcome {
  chunks: RetrievedChunk[];
  /** True only when PostgreSQL full-text search ran instead of vector search. */
  usedLexicalFallback: boolean;
  /** True when the offline embedder produced the query vector (vector search still ran). */
  embeddingUsedFallback: boolean;
  model: string;
}

/**
 * Finds the passages most relevant to a query.
 *
 * Vector search first. If no chunk has been embedded yet — a fresh database, or
 * an embedding provider that was down during indexing — it falls back to
 * PostgreSQL full-text search so retrieval degrades instead of returning
 * nothing. The caller is told which path ran.
 */
export async function retrieve(queryText: string, limit = 4): Promise<RetrievalOutcome> {
  const embedded = await queryOne<{ count: string }>(
    'SELECT COUNT(*)::TEXT AS count FROM kb_chunks WHERE embedding IS NOT NULL'
  );

  if (Number(embedded?.count ?? 0) === 0) {
    return { ...(await lexicalRetrieve(queryText, limit)), embeddingUsedFallback: false, model: 'postgres-fts' };
  }

  try {
    const outcome = await embed([queryText]);
    const literal = toVectorLiteral(outcome.vectors[0]);

    // `<=>` is pgvector's cosine distance: 0 identical, 2 opposite. Converted
    // to a 0–1 similarity so the number shown to a user reads intuitively.
    const rows = await query<{
      chunk_id: string;
      article_id: string;
      title: string;
      content: string;
      distance: string;
    }>(
      `SELECT c.id AS chunk_id, c.article_id, a.title, c.content,
              (c.embedding <=> $1::vector) AS distance
         FROM kb_chunks c
         JOIN kb_articles a ON a.id = c.article_id
        WHERE c.embedding IS NOT NULL
          AND a.is_published = TRUE
        ORDER BY c.embedding <=> $1::vector
        LIMIT $2`,
      [literal, limit]
    );

    return {
      chunks: rows.map((r) => ({
        chunkId: r.chunk_id,
        articleId: r.article_id,
        articleTitle: r.title,
        content: r.content,
        score: Math.max(0, 1 - Number(r.distance)),
      })),
      // Vector search ran, so this is NOT the lexical fallback — that flag was
      // previously set from the embedder's fallback status, which mislabelled
      // every deterministic-embedder search as a full-text search.
      usedLexicalFallback: false,
      embeddingUsedFallback: outcome.usedFallback,
      model: outcome.model,
    };
  } catch (error) {
    log.warn({ err: (error as Error).message }, 'vector retrieval failed - using lexical search');
    return { ...(await lexicalRetrieve(queryText, limit)), embeddingUsedFallback: false, model: 'postgres-fts' };
  }
}

/** Keyword retrieval over the GIN index, used when vectors are unavailable. */
async function lexicalRetrieve(
  queryText: string,
  limit: number
): Promise<{ chunks: RetrievedChunk[]; usedLexicalFallback: boolean }> {
  const rows = await query<{
    chunk_id: string;
    article_id: string;
    title: string;
    content: string;
    rank: string;
  }>(
    `SELECT c.id AS chunk_id, c.article_id, a.title, c.content,
            ts_rank(to_tsvector('english', c.content),
                    plainto_tsquery('english', $1)) AS rank
       FROM kb_chunks c
       JOIN kb_articles a ON a.id = c.article_id
      WHERE a.is_published = TRUE
        AND to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $2`,
    [queryText, limit]
  );

  return {
    chunks: rows.map((r) => ({
      chunkId: r.chunk_id,
      articleId: r.article_id,
      articleTitle: r.title,
      content: r.content,
      score: Number(r.rank),
    })),
    usedLexicalFallback: true,
  };
}

/** Records what was retrieved, for citations and for offline evaluation. */
export async function recordRetrieval(
  ticketId: string | null,
  queryText: string,
  outcome: RetrievalOutcome
): Promise<void> {
  try {
    await query(
      `INSERT INTO kb_retrievals (ticket_id, query_text, results, top_score, used_lexical_fallback)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        ticketId,
        queryText.slice(0, 1000),
        JSON.stringify(
          outcome.chunks.map((c) => ({ chunkId: c.chunkId, articleId: c.articleId, score: c.score }))
        ),
        outcome.chunks[0]?.score ?? null,
        outcome.usedLexicalFallback,
      ]
    );
  } catch (error) {
    log.error({ err: (error as Error).message }, 'failed to record retrieval');
  }
}
