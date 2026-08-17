import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ApiError } from '../utils/ApiError';

type Source = 'body' | 'query' | 'params';

/**
 * Validates and replaces one part of the request with the parsed result.
 *
 * Because the parsed value is written back, handlers downstream receive data
 * that is already typed, trimmed and coerced — no handler re-checks shapes.
 */
export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      next(ApiError.badRequest('The submitted data is not valid.', details));
      return;
    }

    // req.query is a getter on newer Express versions, so assign defensively.
    Object.defineProperty(req, source, { value: result.data, writable: true });
    next();
  };
}
