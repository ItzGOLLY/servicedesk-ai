import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler, ok, paginationMeta } from '../../utils/http';

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

const listSchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/notifications — always scoped to the caller, never to a supplied id
notificationsRouter.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { unreadOnly, page, limit } = req.query as never as z.infer<typeof listSchema>;
    const onlyUnread = unreadOnly === 'true';

    const totals = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM notifications
        WHERE user_id = $1 AND ($2::BOOLEAN = FALSE OR is_read = FALSE)`,
      [req.user!.id, onlyUnread]
    );

    const rows = await query<{
      id: string;
      type: string;
      title: string;
      body: string;
      is_read: boolean;
      ticket_id: string | null;
      created_at: Date;
      reference: string | null;
    }>(
      `SELECT n.id, n.type, n.title, n.body, n.is_read, n.ticket_id, n.created_at, t.reference
         FROM notifications n
         LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = $1 AND ($2::BOOLEAN = FALSE OR n.is_read = FALSE)
        ORDER BY n.created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.user!.id, onlyUnread, limit, (page - 1) * limit]
    );

    ok(
      res,
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        isRead: r.is_read,
        ticketId: r.ticket_id,
        ticketReference: r.reference,
        createdAt: r.created_at,
      })),
      paginationMeta(page, limit, Number(totals[0]?.count ?? 0))
    );
  })
);

// GET /api/notifications/unread-count — drives the bell badge
notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req: Request, res: Response) => {
    const row = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.user!.id]
    );
    ok(res, { count: Number(row?.count ?? 0) });
  })
);

// PATCH /api/notifications/:id/read
notificationsRouter.patch(
  '/:id/read',
  asyncHandler(async (req: Request, res: Response) => {
    // The user_id predicate is what stops one user marking another's notification.
    const row = await queryOne<{ id: string }>(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user!.id]
    );
    if (!row) throw ApiError.notFound('Notification not found.');
    ok(res, { id: row.id, isRead: true });
  })
);

// PATCH /api/notifications/read-all
notificationsRouter.patch(
  '/read-all',
  asyncHandler(async (req: Request, res: Response) => {
    const rows = await query<{ id: string }>(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE RETURNING id',
      [req.user!.id]
    );
    ok(res, { updated: rows.length });
  })
);
