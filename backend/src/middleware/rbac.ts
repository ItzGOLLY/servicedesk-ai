import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import type { UserRole } from '../types';

/**
 * Route-level role check.
 *
 * This is the first of two authorisation layers. It answers "may this role use
 * this endpoint at all?". Record-level ownership ("is this *your* ticket?") is
 * checked separately inside the handlers, because the answer depends on data
 * this middleware cannot see.
 */
export function requireRole(...allowed: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(ApiError.unauthorized());
      return;
    }
    if (!allowed.includes(req.user.role)) {
      next(
        ApiError.forbidden(
          `This action requires one of the following roles: ${allowed.join(', ')}.`
        )
      );
      return;
    }
    next();
  };
}

/** Convenience wrappers for the three common cases. */
export const requireAdmin = requireRole('ADMIN');
export const requireStaff = requireRole('AGENT', 'ADMIN');
