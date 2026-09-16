import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler, created, noContent, ok, paginationMeta } from '../../utils/http';
import { recordAudit } from '../../services/audit';
import { embeddingStatus } from '../../services/embeddings';
import { indexArticle, recordRetrieval, retrieve } from './knowledge.service';

export const knowledgeRouter = Router();

knowledgeRouter.use(requireAuth);

const articleSchema = z.object({
  title: z.string().trim().min(4, 'Title must be at least 4 characters.').max(200),
  body: z.string().trim().min(30, 'An article needs at least 30 characters of content.').max(20000),
  categoryId: z.string().uuid().nullable().optional(),
  isPublished: z.boolean().optional(),
});

interface ArticleRow {
  id: string;
  title: string;
  body: string;
  is_published: boolean;
  category_id: string | null;
  category_name: string | null;
  created_at: Date;
  updated_at: Date;
  chunk_count?: string;
}

const toDto = (r: ArticleRow) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  isPublished: r.is_published,
  category: r.category_id ? { id: r.category_id, name: r.category_name } : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.chunk_count !== undefined ? { chunkCount: Number(r.chunk_count) } : {}),
});

// GET /api/knowledge — staff browse the knowledge base
knowledgeRouter.get(
  '/',
  requireRole('AGENT', 'ADMIN'),
  validate(
    z.object({
      q: z.string().trim().max(200).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    'query'
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { q, page, limit } = req.query as never as { q?: string; page: number; limit: number };

    const params: unknown[] = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE a.title ILIKE $${params.length} OR a.body ILIKE $${params.length}`;
    }

    const totals = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM kb_articles a ${where}`,
      params
    );

    const rows = await query<ArticleRow>(
      `SELECT a.id, a.title, a.body, a.is_published, a.category_id, c.name AS category_name,
              a.created_at, a.updated_at,
              (SELECT COUNT(*)::TEXT FROM kb_chunks k WHERE k.article_id = a.id) AS chunk_count
         FROM kb_articles a
         LEFT JOIN categories c ON c.id = a.category_id
         ${where}
        ORDER BY a.updated_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    ok(res, rows.map(toDto), paginationMeta(page, limit, Number(totals[0]?.count ?? 0)));
  })
);

// POST /api/knowledge — admins author articles
knowledgeRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(articleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { title, body, categoryId, isPublished } = req.body;

    const article = await queryOne<ArticleRow>(
      `INSERT INTO kb_articles (title, body, category_id, is_published, author_id)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), $5)
       RETURNING id, title, body, is_published, category_id, NULL::TEXT AS category_name,
                 created_at, updated_at`,
      [title, body, categoryId ?? null, isPublished ?? null, req.user!.id]
    );

    // Indexing is awaited here, unlike ticket classification: an article that
    // is saved but not indexed is invisible to retrieval, and the author needs
    // to know that happened rather than discover it later.
    const indexed = await indexArticle(article!.id);

    await recordAudit(req, 'KB_ARTICLE_CREATED', 'kb_article', article!.id, { title });
    created(res, { ...toDto(article!), chunkCount: indexed.chunks, embeddingModel: indexed.model });
  })
);

// A UUID-only matcher. Express's :id already matches one segment, so
// /status/embeddings never collided with it — but making the intent explicit
// costs nothing and turns a garbage id into a clean 404 instead of a
// database-error-derived 400.
const UUID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';

// GET /api/knowledge/:id
knowledgeRouter.get(
  `/:id${UUID}`,
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const article = await queryOne<ArticleRow>(
      `SELECT a.id, a.title, a.body, a.is_published, a.category_id, c.name AS category_name,
              a.created_at, a.updated_at,
              (SELECT COUNT(*)::TEXT FROM kb_chunks k WHERE k.article_id = a.id) AS chunk_count
         FROM kb_articles a LEFT JOIN categories c ON c.id = a.category_id
        WHERE a.id = $1`,
      [req.params.id]
    );
    if (!article) throw ApiError.notFound('Article not found.');
    ok(res, toDto(article));
  })
);

// PATCH /api/knowledge/:id — editing re-indexes, or the index goes stale
knowledgeRouter.patch(
  `/:id${UUID}`,
  requireRole('ADMIN'),
  validate(articleSchema.partial()),
  asyncHandler(async (req: Request, res: Response) => {
    const { title, body, categoryId, isPublished } = req.body;

    const article = await queryOne<ArticleRow>(
      `UPDATE kb_articles
          SET title = COALESCE($1, title),
              body = COALESCE($2, body),
              category_id = CASE WHEN $3::BOOLEAN THEN $4::UUID ELSE category_id END,
              is_published = COALESCE($5, is_published)
        WHERE id = $6
        RETURNING id, title, body, is_published, category_id, NULL::TEXT AS category_name,
                  created_at, updated_at`,
      [
        title ?? null,
        body ?? null,
        Object.prototype.hasOwnProperty.call(req.body, 'categoryId'),
        categoryId ?? null,
        isPublished ?? null,
        req.params.id,
      ]
    );
    if (!article) throw ApiError.notFound('Article not found.');

    // Content changes invalidate every embedding for the article.
    const indexed = title !== undefined || body !== undefined
      ? await indexArticle(article.id)
      : { chunks: 0, model: 'unchanged' };

    await recordAudit(req, 'KB_ARTICLE_UPDATED', 'kb_article', article.id, req.body);
    ok(res, { ...toDto(article), reindexedChunks: indexed.chunks });
  })
);

// DELETE /api/knowledge/:id — chunks cascade
knowledgeRouter.delete(
  `/:id${UUID}`,
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const article = await queryOne<{ id: string; title: string }>(
      'SELECT id, title FROM kb_articles WHERE id = $1',
      [req.params.id]
    );
    if (!article) throw ApiError.notFound('Article not found.');

    await query('DELETE FROM kb_articles WHERE id = $1', [article.id]);
    await recordAudit(req, 'KB_ARTICLE_DELETED', 'kb_article', article.id, { title: article.title });
    noContent(res);
  })
);

// POST /api/knowledge/:id/reindex — after an embedding provider change
knowledgeRouter.post(
  `/:id${UUID}/reindex`,
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const exists = await queryOne('SELECT id FROM kb_articles WHERE id = $1', [req.params.id]);
    if (!exists) throw ApiError.notFound('Article not found.');

    const indexed = await indexArticle(req.params.id);
    await recordAudit(req, 'KB_ARTICLE_REINDEXED', 'kb_article', req.params.id, indexed);
    ok(res, indexed);
  })
);

// POST /api/knowledge/search — raw retrieval, for tuning and demonstration
knowledgeRouter.post(
  '/search',
  requireRole('AGENT', 'ADMIN'),
  validate(
    z.object({
      query: z.string().trim().min(3, 'Enter at least 3 characters.').max(1000),
      limit: z.number().int().min(1).max(10).optional(),
    })
  ),
  asyncHandler(async (req: Request, res: Response) => {
    const { query: queryText, limit } = req.body;
    const outcome = await retrieve(queryText, limit ?? 4);
    await recordRetrieval(null, queryText, outcome);

    ok(res, {
      results: outcome.chunks,
      usedLexicalFallback: outcome.usedLexicalFallback,
      embeddingUsedFallback: outcome.embeddingUsedFallback,
      embeddingModel: outcome.model,
      // Semantic only if a semantic embedder actually ran AND vector search ran.
      semantic:
        embeddingStatus.semantic && !outcome.embeddingUsedFallback && !outcome.usedLexicalFallback,
    });
  })
);

// GET /api/knowledge/status/embeddings — which engine is live
knowledgeRouter.get(
  '/status/embeddings',
  requireRole('ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const counts = await queryOne<{ articles: string; chunks: string; embedded: string }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM kb_articles) AS articles,
         (SELECT COUNT(*)::TEXT FROM kb_chunks) AS chunks,
         (SELECT COUNT(*)::TEXT FROM kb_chunks WHERE embedding IS NOT NULL) AS embedded`
    );

    ok(res, {
      ...embeddingStatus,
      articles: Number(counts?.articles ?? 0),
      chunks: Number(counts?.chunks ?? 0),
      embeddedChunks: Number(counts?.embedded ?? 0),
    });
  })
);
