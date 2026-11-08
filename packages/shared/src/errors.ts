/** Erreurs applicatives communes à l'API, au bot et aux clients TypeScript. */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(code: ErrorCode, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Données invalides', details?: unknown) {
    super('VALIDATION_ERROR', 400, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentification requise') {
    super('UNAUTHORIZED', 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Accès refusé') {
    super('FORBIDDEN', 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') {
    super('NOT_FOUND', 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflit avec l’état actuel de la ressource', details?: unknown) {
    super('CONFLICT', 409, message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Trop de requêtes') {
    super('RATE_LIMITED', 429, message);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Convertit n'importe quelle erreur en réponse JSON publique.
 * Les erreurs inattendues ne laissent jamais fuiter leur message (peut contenir des secrets).
 */
export function toErrorBody(err: unknown, requestId?: string): { status: number; body: ErrorResponseBody } {
  if (isAppError(err)) {
    const body: ErrorResponseBody = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    if (requestId) body.error.requestId = requestId;
    return { status: err.httpStatus, body };
  }
  const body: ErrorResponseBody = { error: { code: 'INTERNAL_ERROR', message: 'Erreur interne' } };
  if (requestId) body.error.requestId = requestId;
  return { status: 500, body };
}
