import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok } from '../../utils/http';

export const reportsRouter = Router();

// Reports aggregate across every customer, so they are staff-only.
reportsRouter.use(requireAuth, requireRole('AGENT', 'ADMIN'));

const num = (v: string | null | undefined) => Number(v ?? 0);
const shape = (rows: { label: string; count: string }[]) =>
  rows.map((r) => ({ label: r.label, count: num(r.count) }));

reportsRouter.get(
  '/tickets-by-status',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{ label: string; count: string }>(
      `SELECT status::TEXT AS label, COUNT(*)::TEXT AS count FROM tickets GROUP BY status ORDER BY status`
    );
    ok(res, shape(rows));
  })
);

reportsRouter.get(
  '/tickets-by-priority',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{ label: string; count: string }>(
      `SELECT priority::TEXT AS label, COUNT(*)::TEXT AS count FROM tickets GROUP BY priority ORDER BY priority`
    );
    ok(res, shape(rows));
  })
);

reportsRouter.get(
  '/tickets-by-category',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{ label: string; count: string }>(
      `SELECT COALESCE(c.name, 'Uncategorised') AS label, COUNT(*)::TEXT AS count
         FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
        GROUP BY c.name ORDER BY COUNT(*) DESC`
    );
    ok(res, shape(rows));
  })
);

reportsRouter.get(
  '/sentiment',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{ label: string; count: string }>(
      `SELECT COALESCE(sentiment::TEXT, 'UNCLASSIFIED') AS label, COUNT(*)::TEXT AS count
         FROM tickets GROUP BY sentiment ORDER BY COUNT(*) DESC`
    );
    ok(res, shape(rows));
  })
);

reportsRouter.get(
  '/agent-workload',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{
      name: string;
      email: string;
      open: string;
      resolved: string;
      avg_hours: string | null;
    }>(
      `SELECT u.full_name AS name, u.email,
              COUNT(t.id) FILTER (WHERE t.status NOT IN ('RESOLVED','CLOSED'))::TEXT AS open,
              COUNT(t.id) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::TEXT AS resolved,
              ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)::NUMERIC, 1)::TEXT AS avg_hours
         FROM users u LEFT JOIN tickets t ON t.assigned_agent_id = u.id
        WHERE u.role IN ('AGENT','ADMIN') AND u.is_active
        GROUP BY u.id, u.full_name, u.email
        ORDER BY COUNT(t.id) DESC`
    );

    ok(
      res,
      rows.map((r) => ({
        name: r.name,
        email: r.email,
        open: num(r.open),
        resolved: num(r.resolved),
        averageResolutionHours: r.avg_hours ? Number(r.avg_hours) : null,
      }))
    );
  })
);

reportsRouter.get(
  '/trends',
  validate(z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }), 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { days } = req.query as never as { days: number };
    const rows = await query<{ day: string; created: string; resolved: string }>(
      `SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
              COUNT(c.id)::TEXT AS created,
              COUNT(r.id)::TEXT AS resolved
         FROM generate_series(CURRENT_DATE - ($1::INT - 1) * INTERVAL '1 day', CURRENT_DATE, '1 day') AS d(day)
         LEFT JOIN tickets c ON DATE(c.created_at) = d.day
         LEFT JOIN tickets r ON DATE(r.resolved_at) = d.day
        GROUP BY d.day ORDER BY d.day`,
      [days]
    );

    ok(
      res,
      rows.map((r) => ({ day: r.day, created: num(r.created), resolved: num(r.resolved) }))
    );
  })
);

reportsRouter.get(
  '/resolution-time',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{
      label: string;
      avg_hours: string | null;
      resolved: string;
    }>(
      `SELECT COALESCE(c.name, 'Uncategorised') AS label,
              ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600)::NUMERIC, 1)::TEXT AS avg_hours,
              COUNT(t.id)::TEXT AS resolved
         FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.resolved_at IS NOT NULL
        GROUP BY c.name ORDER BY AVG(t.resolved_at - t.created_at) DESC`
    );

    ok(
      res,
      rows.map((r) => ({
        label: r.label,
        averageResolutionHours: r.avg_hours ? Number(r.avg_hours) : null,
        resolvedCount: num(r.resolved),
      }))
    );
  })
);

/**
 * CSV export.
 *
 * Fields are quoted and embedded quotes doubled, per RFC 4180. A subject
 * beginning with "=" would otherwise be interpreted as a formula by spreadsheet
 * software, so those values are prefixed with an apostrophe.
 */
function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const escape = (value: string | number | null): string => {
    if (value === null || value === undefined) return '""';
    let text = String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\r\n');
}

reportsRouter.get(
  '/export',
  validate(z.object({ format: z.enum(['csv']).default('csv') }), 'query'),
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<{
      reference: string;
      subject: string;
      status: string;
      priority: string;
      sentiment: string | null;
      category: string | null;
      customer: string;
      agent: string | null;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT t.reference, t.subject, t.status::TEXT, t.priority::TEXT, t.sentiment::TEXT,
              c.name AS category, cu.full_name AS customer, ag.full_name AS agent,
              t.created_at, t.resolved_at
         FROM tickets t
         JOIN users cu ON cu.id = t.customer_id
         LEFT JOIN users ag ON ag.id = t.assigned_agent_id
         LEFT JOIN categories c ON c.id = t.category_id
        ORDER BY t.created_at DESC`
    );

    const csv = toCsv(
      ['Reference', 'Subject', 'Status', 'Priority', 'Sentiment', 'Category', 'Customer', 'Agent', 'Created', 'Resolved'],
      rows.map((r) => [
        r.reference,
        r.subject,
        r.status,
        r.priority,
        r.sentiment,
        r.category,
        r.customer,
        r.agent,
        r.created_at.toISOString(),
        r.resolved_at ? r.resolved_at.toISOString() : null,
      ])
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="servicedesk-tickets.csv"');
    res.status(200).send(csv);
  })
);
