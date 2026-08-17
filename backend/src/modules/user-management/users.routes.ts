import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool';
import { requireAuth } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler, created, ok, paginationMeta } from '../../utils/http';
import { hashPassword, verifyPassword } from '../../utils/security';
import { recordAudit } from '../../services/audit';
import { changePasswordSchema } from '../authentication/auth.schemas';
import type { UserRole } from '../../types';

export const usersRouter = Router();

usersRouter.use(requireAuth);

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  phone: string | null;
  is_active: boolean;
  created_at: Date;
}

const toDto = (r: UserRow) => ({
  id: r.id,
  email: r.email,
  fullName: r.full_name,
  role: r.role,
  phone: r.phone,
  isActive: r.is_active,
  createdAt: r.created_at,
});

const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(20).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update.' });

const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  role: z.enum(['CUSTOMER', 'AGENT', 'ADMIN']),
  phone: z.string().trim().max(20).optional(),
});

const listUsersSchema = z.object({
  role: z.enum(['CUSTOMER', 'AGENT', 'ADMIN']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// --- current user -----------------------------------------------------------

// GET /api/users/me
usersRouter.get(
  '/me',
  asyncHandler(async (req: Request, res: Response) => {
    const user = await queryOne<UserRow>(
      'SELECT id, email, full_name, role, phone, is_active, created_at FROM users WHERE id = $1',
      [req.user!.id]
    );
    if (!user) throw ApiError.notFound('User not found.');
    ok(res, toDto(user));
  })
);

// PATCH /api/users/me — a user may edit their name and phone, never their own role
usersRouter.patch(
  '/me',
  validate(updateProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { fullName, phone } = req.body;
    const user = await queryOne<UserRow>(
      `UPDATE users
          SET full_name = COALESCE($1, full_name),
              phone = CASE WHEN $2::BOOLEAN THEN $3 ELSE phone END
        WHERE id = $4
        RETURNING id, email, full_name, role, phone, is_active, created_at`,
      [
        fullName ?? null,
        Object.prototype.hasOwnProperty.call(req.body, 'phone'),
        phone ?? null,
        req.user!.id,
      ]
    );
    ok(res, toDto(user!));
  })
);

// PATCH /api/users/me/password
usersRouter.patch(
  '/me/password',
  validate(changePasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    const user = await queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.id]
    );
    if (!user) throw ApiError.notFound('User not found.');

    const matches = await verifyPassword(currentPassword, user.password_hash);
    if (!matches) throw ApiError.badRequest('Your current password is incorrect.');

    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await hashPassword(newPassword),
      req.user!.id,
    ]);
    await recordAudit(req, 'PASSWORD_CHANGED', 'user', req.user!.id);

    ok(res, { message: 'Password updated.' });
  })
);

// GET /api/users/agents — staff need the agent list to assign tickets
usersRouter.get(
  '/agents',
  requireRole('AGENT', 'ADMIN'),
  asyncHandler(async (_req: Request, res: Response) => {
    const agents = await query<UserRow>(
      `SELECT id, email, full_name, role, phone, is_active, created_at
         FROM users
        WHERE role IN ('AGENT', 'ADMIN') AND is_active = TRUE
        ORDER BY full_name`
    );
    ok(res, agents.map(toDto));
  })
);

// --- administration ---------------------------------------------------------

// GET /api/users — admin only
usersRouter.get(
  '/',
  requireRole('ADMIN'),
  validate(listUsersSchema, 'query'),
  asyncHandler(async (req: Request, res: Response) => {
    const { role, isActive, q, page, limit } = req.query as never as z.infer<typeof listUsersSchema>;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (role) {
      params.push(role);
      clauses.push(`role = $${params.length}`);
    }
    if (isActive) {
      params.push(isActive === 'true');
      clauses.push(`is_active = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      clauses.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const totals = await query<{ count: string }>(
      `SELECT COUNT(*)::TEXT AS count FROM users ${where}`,
      params
    );
    const total = Number(totals[0]?.count ?? 0);

    const users = await query<UserRow>(
      `SELECT id, email, full_name, role, phone, is_active, created_at
         FROM users ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit]
    );

    ok(res, users.map(toDto), paginationMeta(page, limit, total));
  })
);

// POST /api/users — admin creates staff accounts
usersRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { fullName, email, password, role, phone } = req.body;

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) throw ApiError.conflict('An account with this email address already exists.');

    const user = await queryOne<UserRow>(
      `INSERT INTO users (email, password_hash, full_name, role, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, full_name, role, phone, is_active, created_at`,
      [email, await hashPassword(password), fullName, role, phone ?? null]
    );

    await recordAudit(req, 'USER_CREATED', 'user', user!.id, { email, role });
    created(res, toDto(user!));
  })
);

// GET /api/users/:id — admin only
usersRouter.get(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const user = await queryOne<UserRow>(
      'SELECT id, email, full_name, role, phone, is_active, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!user) throw ApiError.notFound('User not found.');

    const stats = await queryOne<{ created: string; assigned: string }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM tickets WHERE customer_id = $1)       AS created,
         (SELECT COUNT(*)::TEXT FROM tickets WHERE assigned_agent_id = $1) AS assigned`,
      [user.id]
    );

    ok(res, {
      ...toDto(user),
      stats: {
        ticketsCreated: Number(stats?.created ?? 0),
        ticketsAssigned: Number(stats?.assigned ?? 0),
      },
    });
  })
);

// PATCH /api/users/:id/role
usersRouter.patch(
  '/:id/role',
  requireRole('ADMIN'),
  validate(z.object({ role: z.enum(['CUSTOMER', 'AGENT', 'ADMIN']) })),
  asyncHandler(async (req: Request, res: Response) => {
    const { role } = req.body;

    // Removing the last admin would lock everyone out of the admin module.
    if (req.params.id === req.user!.id && role !== 'ADMIN') {
      throw ApiError.unprocessable('You cannot remove your own administrator role.');
    }

    const user = await queryOne<UserRow>(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, email, full_name, role, phone, is_active, created_at`,
      [role, req.params.id]
    );
    if (!user) throw ApiError.notFound('User not found.');

    await recordAudit(req, 'USER_ROLE_CHANGED', 'user', user.id, { role });
    ok(res, toDto(user));
  })
);

// PATCH /api/users/:id/status — deactivate or reactivate
usersRouter.patch(
  '/:id/status',
  requireRole('ADMIN'),
  validate(z.object({ isActive: z.boolean() })),
  asyncHandler(async (req: Request, res: Response) => {
    const { isActive } = req.body;

    if (req.params.id === req.user!.id && !isActive) {
      throw ApiError.unprocessable('You cannot deactivate your own account.');
    }

    const user = await queryOne<UserRow>(
      `UPDATE users SET is_active = $1 WHERE id = $2
       RETURNING id, email, full_name, role, phone, is_active, created_at`,
      [isActive, req.params.id]
    );
    if (!user) throw ApiError.notFound('User not found.');

    await recordAudit(req, isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'user', user.id);
    ok(res, toDto(user));
  })
);
