import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler, created, noContent, ok } from '../../utils/http';
import { recordAudit } from '../../services/audit';

export const categoriesRouter = Router();

categoriesRouter.use(requireAuth);

const categorySchema = z.object({
  name: z.string().trim().min(2, 'Category name must be at least 2 characters.').max(60),
  description: z.string().trim().max(300).optional().nullable(),
  isActive: z.boolean().optional(),
});

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: Date;
  ticket_count?: string;
}

const toDto = (r: CategoryRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  isActive: r.is_active,
  createdAt: r.created_at,
  ...(r.ticket_count !== undefined ? { ticketCount: Number(r.ticket_count) } : {}),
});

// GET /api/categories — every authenticated user needs these to file a ticket
categoriesRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const isAdmin = req.user!.role === 'ADMIN';
    const rows = await query<CategoryRow>(
      `SELECT c.id, c.name, c.description, c.is_active, c.created_at,
              COUNT(t.id)::TEXT AS ticket_count
         FROM categories c
         LEFT JOIN tickets t ON t.category_id = c.id
        WHERE ($1::BOOLEAN OR c.is_active = TRUE)
        GROUP BY c.id
        ORDER BY c.name`,
      [isAdmin]
    );
    ok(res, rows.map(toDto));
  })
);

// POST /api/categories — admin only
categoriesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(categorySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, description } = req.body;

    const existing = await queryOne('SELECT id FROM categories WHERE LOWER(name) = LOWER($1)', [name]);
    if (existing) throw ApiError.conflict('A category with that name already exists.');

    const row = await queryOne<CategoryRow>(
      `INSERT INTO categories (name, description) VALUES ($1, $2)
       RETURNING id, name, description, is_active, created_at`,
      [name, description ?? null]
    );

    await recordAudit(req, 'CATEGORY_CREATED', 'category', row!.id, { name });
    created(res, toDto(row!));
  })
);

// PATCH /api/categories/:id — admin only
categoriesRouter.patch(
  '/:id',
  requireRole('ADMIN'),
  validate(categorySchema.partial()),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, description, isActive } = req.body;

    const row = await queryOne<CategoryRow>(
      `UPDATE categories
          SET name        = COALESCE($1, name),
              description = COALESCE($2, description),
              is_active   = COALESCE($3, is_active)
        WHERE id = $4
        RETURNING id, name, description, is_active, created_at`,
      [name ?? null, description ?? null, isActive ?? null, req.params.id]
    );
    if (!row) throw ApiError.notFound('Category not found.');

    await recordAudit(req, 'CATEGORY_UPDATED', 'category', row.id, req.body);
    ok(res, toDto(row));
  })
);

// DELETE /api/categories/:id — admin only
categoriesRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const category = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM categories WHERE id = $1',
      [req.params.id]
    );
    if (!category) throw ApiError.notFound('Category not found.');

    const inUse = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM tickets WHERE category_id = $1',
      [category.id]
    );

    // Deleting a category in use would silently strip it from historical tickets
    // and distort the category report, so deactivation is offered instead.
    if (Number(inUse?.count ?? 0) > 0) {
      throw ApiError.conflict(
        `This category is used by ${inUse!.count} ticket(s). Deactivate it instead of deleting it.`
      );
    }

    await query('DELETE FROM categories WHERE id = $1', [category.id]);
    await recordAudit(req, 'CATEGORY_DELETED', 'category', category.id, { name: category.name });

    noContent(res);
  })
);
