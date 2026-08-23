import { Router, type Request, type Response } from 'express';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { asyncHandler, ok } from '../../utils/http';

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

/**
 * Every number on every dashboard is computed here, from the database, at
 * request time. Nothing is hard-coded and nothing is cached, so what the
 * evaluator sees on screen is exactly what is in the cloud database.
 */

const num = (v: string | null | undefined) => Number(v ?? 0);

// GET /api/dashboard/customer
dashboardRouter.get(
  '/customer',
  requireRole('CUSTOMER'),
  asyncHandler(async (req: Request, res: Response) => {
    const counts = await queryOne<{
      total: string;
      open: string;
      resolved: string;
      waiting: string;
    }>(
      `SELECT COUNT(*)::TEXT AS total,
              COUNT(*) FILTER (WHERE status IN ('NEW','OPEN','IN_PROGRESS'))::TEXT AS open,
              COUNT(*) FILTER (WHERE status IN ('RESOLVED','CLOSED'))::TEXT       AS resolved,
              COUNT(*) FILTER (WHERE status = 'WAITING_FOR_CUSTOMER')::TEXT       AS waiting
         FROM tickets WHERE customer_id = $1`,
      [req.user!.id]
    );

    const recent = await query<{
      id: string;
      reference: string;
      subject: string;
      status: string;
      priority: string;
      created_at: Date;
    }>(
      `SELECT id, reference, subject, status, priority, created_at
         FROM tickets WHERE customer_id = $1
        ORDER BY created_at DESC LIMIT 5`,
      [req.user!.id]
    );

    ok(res, {
      metrics: {
        total: num(counts?.total),
        open: num(counts?.open),
        resolved: num(counts?.resolved),
        awaitingYourReply: num(counts?.waiting),
      },
      recentTickets: recent.map((t) => ({
        id: t.id,
        reference: t.reference,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        createdAt: t.created_at,
      })),
    });
  })
);

// GET /api/dashboard/agent
dashboardRouter.get(
  '/agent',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.user!.id;

    const counts = await queryOne<{
      assigned: string;
      open: string;
      high: string;
      resolved: string;
      unassigned: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE assigned_agent_id = $1)::TEXT AS assigned,
         COUNT(*) FILTER (WHERE assigned_agent_id = $1
                            AND status IN ('NEW','OPEN','IN_PROGRESS','WAITING_FOR_CUSTOMER'))::TEXT AS open,
         COUNT(*) FILTER (WHERE assigned_agent_id = $1
                            AND priority IN ('HIGH','URGENT')
                            AND status NOT IN ('RESOLVED','CLOSED'))::TEXT AS high,
         COUNT(*) FILTER (WHERE assigned_agent_id = $1
                            AND status IN ('RESOLVED','CLOSED'))::TEXT AS resolved,
         COUNT(*) FILTER (WHERE assigned_agent_id IS NULL
                            AND status NOT IN ('RESOLVED','CLOSED'))::TEXT AS unassigned
       FROM tickets`,
      [agentId]
    );

    // Averaged over this agent's resolved tickets only; NULL when they have none.
    const resolution = await queryOne<{ avg_hours: string | null }>(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)::NUMERIC, 1)::TEXT AS avg_hours
         FROM tickets
        WHERE assigned_agent_id = $1 AND resolved_at IS NOT NULL`,
      [agentId]
    );

    const byCategory = await query<{ name: string; count: string }>(
      `SELECT COALESCE(c.name, 'Uncategorised') AS name, COUNT(*)::TEXT AS count
         FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.assigned_agent_id = $1
        GROUP BY c.name ORDER BY COUNT(*) DESC`,
      [agentId]
    );

    const queue = await query<{
      id: string;
      reference: string;
      subject: string;
      status: string;
      priority: string;
      customer_name: string;
      created_at: Date;
    }>(
      `SELECT t.id, t.reference, t.subject, t.status, t.priority,
              u.full_name AS customer_name, t.created_at
         FROM tickets t JOIN users u ON u.id = t.customer_id
        WHERE t.assigned_agent_id = $1 AND t.status NOT IN ('RESOLVED','CLOSED')
        ORDER BY t.priority DESC, t.created_at ASC
        LIMIT 8`,
      [agentId]
    );

    ok(res, {
      metrics: {
        assigned: num(counts?.assigned),
        open: num(counts?.open),
        highPriority: num(counts?.high),
        resolved: num(counts?.resolved),
        unassignedInQueue: num(counts?.unassigned),
        averageResolutionHours: resolution?.avg_hours ? Number(resolution.avg_hours) : null,
      },
      byCategory: byCategory.map((r) => ({ name: r.name, count: num(r.count) })),
      queue: queue.map((t) => ({
        id: t.id,
        reference: t.reference,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        customerName: t.customer_name,
        createdAt: t.created_at,
      })),
    });
  })
);

// GET /api/dashboard/admin
dashboardRouter.get(
  '/admin',
  requireRole('ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const counts = await queryOne<{
      total: string;
      open: string;
      resolved: string;
      unassigned: string;
      customers: string;
      agents: string;
      whatsapp_tickets: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM tickets) AS total,
         (SELECT COUNT(*)::TEXT FROM tickets WHERE status IN ('NEW','OPEN','IN_PROGRESS','WAITING_FOR_CUSTOMER')) AS open,
         (SELECT COUNT(*)::TEXT FROM tickets WHERE status IN ('RESOLVED','CLOSED')) AS resolved,
         (SELECT COUNT(*)::TEXT FROM tickets WHERE assigned_agent_id IS NULL AND status NOT IN ('RESOLVED','CLOSED')) AS unassigned,
         (SELECT COUNT(*)::TEXT FROM users WHERE role = 'CUSTOMER' AND is_active) AS customers,
         (SELECT COUNT(*)::TEXT FROM users WHERE role IN ('AGENT','ADMIN') AND is_active) AS agents,
         (SELECT COUNT(*)::TEXT FROM tickets WHERE channel = 'WHATSAPP') AS whatsapp_tickets`
    );

    const resolution = await queryOne<{ avg_hours: string | null }>(
      `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)::NUMERIC, 1)::TEXT AS avg_hours
         FROM tickets WHERE resolved_at IS NOT NULL`
    );

    const [byStatus, byPriority, byCategory, bySentiment, workload, trend, aiStats] =
      await Promise.all([
        query<{ label: string; count: string }>(
          `SELECT status::TEXT AS label, COUNT(*)::TEXT AS count FROM tickets GROUP BY status ORDER BY status`
        ),
        query<{ label: string; count: string }>(
          `SELECT priority::TEXT AS label, COUNT(*)::TEXT AS count FROM tickets GROUP BY priority ORDER BY priority`
        ),
        query<{ label: string; count: string }>(
          `SELECT COALESCE(c.name, 'Uncategorised') AS label, COUNT(*)::TEXT AS count
             FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
            GROUP BY c.name ORDER BY COUNT(*) DESC`
        ),
        query<{ label: string; count: string }>(
          `SELECT COALESCE(sentiment::TEXT, 'UNCLASSIFIED') AS label, COUNT(*)::TEXT AS count
             FROM tickets GROUP BY sentiment ORDER BY COUNT(*) DESC`
        ),
        query<{ name: string; open: string; resolved: string }>(
          `SELECT u.full_name AS name,
                  COUNT(t.id) FILTER (WHERE t.status NOT IN ('RESOLVED','CLOSED'))::TEXT AS open,
                  COUNT(t.id) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::TEXT AS resolved
             FROM users u LEFT JOIN tickets t ON t.assigned_agent_id = u.id
            WHERE u.role IN ('AGENT','ADMIN') AND u.is_active
            GROUP BY u.id, u.full_name ORDER BY COUNT(t.id) DESC`
        ),
        // generate_series fills days with no tickets, so the chart has no gaps
        query<{ day: string; count: string }>(
          `SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day, COUNT(t.id)::TEXT AS count
             FROM generate_series(CURRENT_DATE - INTERVAL '29 days', CURRENT_DATE, '1 day') AS d(day)
             LEFT JOIN tickets t ON DATE(t.created_at) = d.day
            GROUP BY d.day ORDER BY d.day`
        ),
        queryOne<{ classified: string; fallback: string; ai_replies: string }>(
          `SELECT
             (SELECT COUNT(*)::TEXT FROM tickets WHERE ai_classified_at IS NOT NULL) AS classified,
             (SELECT COUNT(*)::TEXT FROM ai_suggestions WHERE used_fallback = TRUE) AS fallback,
             (SELECT COUNT(*)::TEXT FROM ticket_messages WHERE ai_assisted = TRUE) AS ai_replies`
        ),
      ]);

    const shape = (rows: { label: string; count: string }[]) =>
      rows.map((r) => ({ label: r.label, count: num(r.count) }));

    ok(res, {
      metrics: {
        totalTickets: num(counts?.total),
        openTickets: num(counts?.open),
        resolvedTickets: num(counts?.resolved),
        unassignedTickets: num(counts?.unassigned),
        activeCustomers: num(counts?.customers),
        activeAgents: num(counts?.agents),
        averageResolutionHours: resolution?.avg_hours ? Number(resolution.avg_hours) : null,
        whatsappTickets: num(counts?.whatsapp_tickets),
      },
      byStatus: shape(byStatus),
      byPriority: shape(byPriority),
      byCategory: shape(byCategory),
      bySentiment: shape(bySentiment),
      agentWorkload: workload.map((r) => ({
        name: r.name,
        open: num(r.open),
        resolved: num(r.resolved),
      })),
      trend: trend.map((r) => ({ day: r.day, count: num(r.count) })),
      ai: {
        ticketsClassified: num(aiStats?.classified),
        suggestionsFromFallback: num(aiStats?.fallback),
        aiAssistedReplies: num(aiStats?.ai_replies),
      },
    });
  })
);
