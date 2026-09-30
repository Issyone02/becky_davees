import { ZodError } from 'zod';
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string = 'APPLICATION_ERROR',
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(404, `${entity}${id ? ` with id ${id}` : ''} not found`, 'NOT_FOUND');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, message, 'FORBIDDEN');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(422, message, 'VALIDATION_ERROR', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export function handleError(err: unknown) {
    if (err instanceof ZodError) {
    const message = err.issues
      .map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)
      .join('; ');
    return {
      statusCode: 422,
      body: { success: false, error: { code: 'VALIDATION_ERROR', message } },
    };
  }

  
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      body: {
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      },
    };
  }
  console.error('Unhandled error:', err);
  return {
    statusCode: 500,
    body: {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again later.',
      },
    },
  };
}