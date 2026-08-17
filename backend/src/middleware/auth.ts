import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { verifyAccessToken } from '../utils/security';
import { queryOne } from '../db/pool';
import type { UserRole } from '../types';

/**
 * Verifies the bearer token and attaches req.user.
 *
 * The token's role claim is not trusted on its own — the user row is re-read so
 * that a deactivated account, or a role an admin changed a minute ago, takes
 * effect immediately rather than when the token happens to expire.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Missing or malformed Authorization header.');
    }

    const token = header.slice('Bearer '.length).trim();
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw ApiError.unauthorized('Your session has expired. Please sign in again.');
    }

    const user = await queryOne<{ id: string; email: string; role: UserRole; is_active: boolean }>(
      'SELECT id, email, role, is_active FROM users WHERE id = $1',
      [payload.sub]
    );

    if (!user) throw ApiError.unauthorized('Account no longer exists.');
    if (!user.is_active) throw ApiError.forbidden('This account has been deactivated.');

    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
}
