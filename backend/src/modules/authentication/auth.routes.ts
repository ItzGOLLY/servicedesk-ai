import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../../db/pool';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler, created, ok } from '../../utils/http';
import {
  hashPassword,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  verifyRefreshToken,
} from '../../utils/security';
import { isProduction, isTest } from '../../config/env';
import { recordAudit } from '../../services/audit';
import { loginSchema, registerSchema } from './auth.schemas';
import type { UserRole } from '../../types';

export const authRouter = Router();

const REFRESH_COOKIE = 'sd_refresh';

/**
 * Login and registration are rate limited because they are the two endpoints an
 * attacker can call without credentials.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // The suite logs in far more often than a human would; throttling it would
  // test the rate limiter rather than the behaviour under test.
  skip: () => isTest,
  message: {
    success: false,
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Please try again later.' },
  },
});

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  phone: string | null;
  is_active: boolean;
  created_at: Date;
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    phone: row.phone,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

/**
 * The refresh token is stored in an httpOnly cookie so page JavaScript — and
 * therefore any injected script — cannot read it. The short-lived access token
 * is held in memory by the client and sent as a bearer header.
 */
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });
}

// POST /api/auth/register — public. Always creates a CUSTOMER; roles are only
// granted by an admin, so self-registration can never produce a privileged account.
authRouter.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { fullName, email, password, phone } = req.body;

    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      throw ApiError.conflict('An account with this email address already exists.');
    }

    const passwordHash = await hashPassword(password);
    const user = await queryOne<UserRow>(
      `INSERT INTO users (email, password_hash, full_name, phone, role)
       VALUES ($1, $2, $3, $4, 'CUSTOMER')
       RETURNING id, email, full_name, role, phone, is_active, created_at`,
      [email, passwordHash, fullName, phone || null]
    );

    if (!user) throw ApiError.internal('Could not create the account.');

    const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
    setRefreshCookie(res, signRefreshToken(user.id));

    await recordAudit(req, 'USER_REGISTERED', 'user', user.id, { email });

    created(res, { user: publicUser(user), accessToken });
  })
);

// POST /api/auth/login — public
authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;

    const user = await queryOne<UserRow & { password_hash: string }>(
      `SELECT id, email, password_hash, full_name, role, phone, is_active, created_at
       FROM users WHERE email = $1`,
      [email]
    );

    // The same message is returned whether the email is unknown or the password
    // is wrong, so the endpoint cannot be used to enumerate registered accounts.
    const invalid = ApiError.unauthorized('Invalid email or password.');
    if (!user) {
      // Still spend time hashing so response timing does not reveal existence.
      await hashPassword(password);
      throw invalid;
    }

    const matches = await verifyPassword(password, user.password_hash);
    if (!matches) throw invalid;

    if (!user.is_active) {
      throw ApiError.forbidden('This account has been deactivated. Please contact an administrator.');
    }

    const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
    setRefreshCookie(res, signRefreshToken(user.id));

    ok(res, { user: publicUser(user), accessToken });
  })
);

// POST /api/auth/refresh — exchanges the refresh cookie for a new access token
authRouter.post(
  '/refresh',
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw ApiError.unauthorized('No refresh token supplied.');

    let payload: { sub: string };
    try {
      payload = verifyRefreshToken(token);
    } catch {
      throw ApiError.unauthorized('Your session has expired. Please sign in again.');
    }

    const user = await queryOne<UserRow>(
      `SELECT id, email, full_name, role, phone, is_active, created_at
       FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (!user) throw ApiError.unauthorized('Account no longer exists.');
    if (!user.is_active) throw ApiError.forbidden('This account has been deactivated.');

    const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
    setRefreshCookie(res, signRefreshToken(user.id));

    ok(res, { user: publicUser(user), accessToken });
  })
);

// POST /api/auth/logout
authRouter.post('/logout', (req: Request, res: Response) => {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  ok(res, { message: 'Signed out.' });
});

// GET /api/auth/me — the current user, used by the client to restore session state
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await queryOne<UserRow>(
      `SELECT id, email, full_name, role, phone, is_active, created_at
       FROM users WHERE id = $1`,
      [req.user!.id]
    );
    if (!user) throw ApiError.notFound('User not found.');

    const unread = await query<{ count: string }>(
      'SELECT COUNT(*)::TEXT AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [req.user!.id]
    );

    ok(res, { user: publicUser(user), unreadNotifications: Number(unread[0]?.count ?? 0) });
  })
);
