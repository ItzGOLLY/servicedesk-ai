import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { asyncHandler, ok } from '../../utils/http';
import {
  aiStatus,
  answerFromKnowledge,
  draftReply,
  resolutionSteps,
  summariseTicket,
} from '../../services/ai';
import { recordRetrieval, retrieve } from '../knowledge/knowledge.service';
import { embeddingStatus } from '../../services/embeddings';
import { getTicketForUser } from '../tickets/tickets.service';
import type { ConversationContext } from '../../services/ai';

export const aiRouter = Router();

aiRouter.use(requireAuth);

/**
 * These endpoints are agent-facing assistance, never customer-facing automation.
 * Each one returns a *suggestion*. Nothing here writes a customer-visible
 * message — that only happens when the agent posts to /tickets/:id/messages.
 */

async function buildContext(ticketId: string, req: Request): Promise<ConversationContext> {
  const ticket = await getTicketForUser(ticketId, req.user!);

  const messages = await query<{ body: string; full_name: string; role: string }>(
    `SELECT m.body, u.full_name, u.role::TEXT
       FROM ticket_messages m JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = $1 AND m.is_internal_note = FALSE
      ORDER BY m.created_at ASC
      LIMIT 30`,
    [ticket.id]
  );

  return {
    subject: ticket.subject,
    description: ticket.description,
    customerName: ticket.customer_name,
    messages: messages.map((m) => ({
      author: `${m.full_name} (${m.role.toLowerCase()})`,
      body: m.body,
    })),
  };
}

async function storeSuggestion(
  ticketId: string,
  kind: 'DRAFT_REPLY' | 'SUMMARY' | 'RESOLUTION_STEPS' | 'GROUNDED_ANSWER',
  content: unknown,
  model: string,
  usedFallback: boolean
): Promise<void> {
  await query(
    `INSERT INTO ai_suggestions (ticket_id, kind, content, model, used_fallback)
     VALUES ($1, $2, $3, $4, $5)`,
    [ticketId, kind, JSON.stringify(content), model, usedFallback]
  );
}

// POST /api/ai/tickets/:id/draft-reply
aiRouter.post(
  '/tickets/:id/draft-reply',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const context = await buildContext(req.params.id, req);
    const outcome = await draftReply(context);

    await storeSuggestion(req.params.id, 'DRAFT_REPLY', outcome.result, outcome.model, outcome.usedFallback);

    ok(res, {
      draft: outcome.result.draft,
      model: outcome.model,
      usedFallback: outcome.usedFallback,
      // The client shows this verbatim, so the agent is always reminded.
      notice: 'Review and edit this draft before sending it to the customer.',
    });
  })
);

// POST /api/ai/tickets/:id/summary
aiRouter.post(
  '/tickets/:id/summary',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const context = await buildContext(req.params.id, req);
    const outcome = await summariseTicket(context);

    await storeSuggestion(req.params.id, 'SUMMARY', outcome.result, outcome.model, outcome.usedFallback);
    await query('UPDATE tickets SET ai_summary = $1 WHERE id = $2', [
      outcome.result.summary,
      req.params.id,
    ]);

    ok(res, {
      summary: outcome.result.summary,
      model: outcome.model,
      usedFallback: outcome.usedFallback,
    });
  })
);

// POST /api/ai/tickets/:id/resolution-steps
aiRouter.post(
  '/tickets/:id/resolution-steps',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const context = await buildContext(req.params.id, req);
    const outcome = await resolutionSteps(context);

    await storeSuggestion(
      req.params.id,
      'RESOLUTION_STEPS',
      outcome.result,
      outcome.model,
      outcome.usedFallback
    );

    ok(res, {
      steps: outcome.result.steps,
      model: outcome.model,
      usedFallback: outcome.usedFallback,
    });
  })
);

/**
 * POST /api/ai/tickets/:id/grounded-answer
 *
 * The RAG endpoint: retrieve relevant knowledge-base passages, then answer
 * strictly from them. Distinct from /draft-reply, which is free generation —
 * this one is constrained to documented material and returns citations, so the
 * agent can verify the answer against its source before sending.
 */
aiRouter.post(
  '/tickets/:id/grounded-answer',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const context = await buildContext(req.params.id, req);

    // The whole ticket is the query: subject alone is often too terse to
    // retrieve well, and the description carries the specific symptoms.
    const queryText = `${context.subject}\n\n${context.description}`;
    const retrieval = await retrieve(queryText, 4);
    await recordRetrieval(req.params.id, queryText, retrieval);

    const outcome = await answerFromKnowledge(
      context,
      retrieval.chunks.map((c) => ({ id: c.chunkId, title: c.articleTitle, content: c.content }))
    );

    await storeSuggestion(
      req.params.id,
      'GROUNDED_ANSWER',
      { ...outcome.result, retrieved: retrieval.chunks.length },
      outcome.model,
      outcome.usedFallback
    );

    // Only the passages the model actually cited are returned as sources, so
    // the agent is never shown a citation the answer did not use.
    const cited = new Set(outcome.result.citedIds);
    ok(res, {
      answer: outcome.result.answer,
      insufficient: outcome.result.insufficient,
      sources: retrieval.chunks
        .filter((c) => cited.has(c.chunkId))
        .map((c) => ({
          chunkId: c.chunkId,
          articleId: c.articleId,
          title: c.articleTitle,
          excerpt: c.content.slice(0, 240),
          score: Number(c.score.toFixed(4)),
        })),
      retrieval: {
        candidates: retrieval.chunks.length,
        usedLexicalFallback: retrieval.usedLexicalFallback,
        embeddingUsedFallback: retrieval.embeddingUsedFallback,
        embeddingModel: retrieval.model,
        semantic:
          embeddingStatus.semantic && !retrieval.embeddingUsedFallback && !retrieval.usedLexicalFallback,
      },
      model: outcome.model,
      usedFallback: outcome.usedFallback,
      notice: 'Verify this against the cited sources before sending it to the customer.',
    });
  })
);

// GET /api/ai/tickets/:id/suggestions — what the AI has produced for this ticket
aiRouter.get(
  '/tickets/:id/suggestions',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    await getTicketForUser(req.params.id, req.user!);

    const rows = await query<{
      id: string;
      kind: string;
      content: unknown;
      model: string;
      used_fallback: boolean;
      created_at: Date;
    }>(
      `SELECT id, kind::TEXT, content, model, used_fallback, created_at
         FROM ai_suggestions WHERE ticket_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );

    ok(
      res,
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        content: r.content,
        model: r.model,
        usedFallback: r.used_fallback,
        createdAt: r.created_at,
      }))
    );
  })
);

// GET /api/ai/health — lets an admin confirm which engine is live before a demo
aiRouter.get(
  '/health',
  requireRole('ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = await queryOne<{ total: string; fallback: string }>(
      `SELECT COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE used_fallback)::TEXT AS fallback
         FROM ai_suggestions`
    );

    ok(res, {
      embeddings: embeddingStatus,
      configuredProvider: aiStatus.configured,
      activeModel: aiStatus.active,
      usingFallback: aiStatus.usingFallback,
      suggestionsGenerated: Number(stats?.total ?? 0),
      suggestionsFromFallback: Number(stats?.fallback ?? 0),
    });
  })
);
