/**
 * The one error type every handler throws.
 *
 * Carrying the HTTP status and a stable machine-readable code on the error means
 * the global error handler can turn any failure into a correct response without
 * each route repeating that logic — and without leaking a stack trace to users.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication is required.'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action.'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'The requested resource was not found.'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }

  /** Used for requests that parse correctly but break a business rule. */
  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(422, 'UNPROCESSABLE_ENTITY', message, details);
  }

  static internal(message = 'Something went wrong. Please try again.'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}
