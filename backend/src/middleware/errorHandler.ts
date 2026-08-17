import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { isProduction } from '../config/env';

/** 404 for any route that did not match. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}.`,
    },
  });
}

/**
 * The single place an error becomes an HTTP response.
 *
 * Users never see a stack trace or a raw database message: known ApiErrors pass
 * their own message through, and anything else becomes a generic 500 while the
 * real cause is logged server-side.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  // Postgres surfaces constraint violations as coded errors; map the ones a
  // user can actually cause into meaningful responses.
  const pgError = error as { code?: string; constraint?: string; message?: string };
  if (pgError?.code === '23505') {
    res.status(409).json({
      success: false,
      error: { code: 'CONFLICT', message: 'That record already exists.' },
    });
    return;
  }
  if (pgError?.code === '23503') {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'A referenced record does not exist.' },
    });
    return;
  }
  if (pgError?.code === '22P02') {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'A supplied identifier is malformed.' },
    });
    return;
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, error);

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
      ...(isProduction ? {} : { debug: pgError?.message }),
    },
  });
}
