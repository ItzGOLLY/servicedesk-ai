import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { asyncHandler, ok } from '../../utils/http';
import { aiStatus, draftReply, resolutionSteps, summariseTicket } from '../../services/ai';
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
  kind: 'DRAFT_REPLY' | 'SUMMARY' | 'RESOLUTION_STEPS',
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
      configuredProvider: aiStatus.configured,
      activeModel: aiStatus.active,
      usingFallback: aiStatus.usingFallback,
      suggestionsGenerated: Number(stats?.total ?? 0),
      suggestionsFromFallback: Number(stats?.fallback ?? 0),
    });
  })
);
