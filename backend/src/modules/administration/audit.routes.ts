import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { asyncHandler, ok, paginationMeta } from '../../utils/http';

export const auditRouter = Router();

auditRouter.use(requireAuth, requireRole('ADMIN'));

const listSchema = z.object({
  action: z.string().trim().max(60).optional(),
  entityType: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// GET /api/audit-logs — the admin Activity screen
auditRouter.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { action, entityType, page, limit } = req.query as never as z.infer<typeof listSchema>;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (action) {
      params.push(action);
      clauses.push(`a.action = $${params.length}`);
    }
    if (entityType) {
      params.push(entityType);
      clauses.push(`a.entity_type = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totals = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM audit_logs a ${where}`,
      params
    );

    const rows = await query<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      metadata: Record<string, unknown>;
      ip_address: string | null;
      created_at: Date;
      actor_name: string | null;
      actor_email: string | null;
    }>(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata, a.ip_address, a.created_at,
              u.full_name AS actor_name, u.email AS actor_email
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ${where}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    ok(
      res,
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        metadata: r.metadata,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
        actor: r.actor_name ? { name: r.actor_name, email: r.actor_email } : null,
      })),
      paginationMeta(page, limit, Number(totals[0]?.count ?? 0))
    );
  })
);
