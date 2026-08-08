/**
 * Application error carrying an HTTP status and a symbolic code.
 * The global handler (`http/error-handler.ts`) turns it into the
 * `{ error: { code, message, statusCode } }` envelope.
 */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
    Error.captureStackTrace?.(this, AppError)
  }
}

/** 400 — the request is invalid or inconsistent. */
export function badRequest(message: string, code = 'BAD_REQUEST', details?: unknown): AppError {
  return new AppError(400, code, message, details)
}

/** 401 — the token is missing or not valid. */
export function unauthorized(
  message = 'A valid access token is required.',
  code = 'UNAUTHENTICATED',
  details?: unknown,
): AppError {
  return new AppError(401, code, message, details)
}

/** 403 — the token is valid but the permissions are not enough. */
export function forbidden(
  message = 'You do not have enough permissions for this operation.',
  code = 'FORBIDDEN',
  details?: unknown,
): AppError {
  return new AppError(403, code, message, details)
}

/** 404 — the resource does not exist (or is not visible to the user). */
export function notFound(message = 'Resource not found.', code = 'NOT_FOUND', details?: unknown): AppError {
  return new AppError(404, code, message, details)
}

/** 409 — conflict with the current state of the resource. */
export function conflict(message: string, code = 'CONFLICT', details?: unknown): AppError {
  return new AppError(409, code, message, details)
}

/** How the error handler answers a PostgreSQL error it recognises. */
export interface SqlStateMapping {
  statusCode: number
  code: string
  message: string
}

/**
 * PostgreSQL SQLSTATE → HTTP.
 *
 * A `pg` error carries no `statusCode`, so without this table every constraint
 * violation and every malformed uuid in a path parameter came back as
 * `500 INTERNAL_ERROR`: the caller's mistake reported as the server's fault,
 * and an alert for something nobody has to fix.
 *
 * The messages are deliberately generic. The SQLSTATE tells us the *shape* of
 * the problem; the detail pg attaches to the error names the constraint, the
 * table and often the value that failed, and none of that belongs in a
 * response body. Handlers that can say something more precise (the duplicate
 * check in `POST /users`, for instance) already do it before reaching here.
 */
const SQLSTATE_MAP: ReadonlyMap<string, SqlStateMapping> = new Map([
  [
    // unique_violation
    '23505',
    {
      statusCode: 409,
      code: 'ALREADY_EXISTS',
      message: 'A record with those values already exists.',
    },
  ],
  [
    // foreign_key_violation
    '23503',
    {
      statusCode: 409,
      code: 'REFERENCE_CONFLICT',
      message:
        'The operation references a record that does not exist, or one that is still referenced elsewhere.',
    },
  ],
  [
    // check_violation
    '23514',
    {
      statusCode: 400,
      code: 'VALUE_NOT_ALLOWED',
      message: 'One of the values is not among those this field accepts.',
    },
  ],
  [
    // not_null_violation
    '23502',
    {
      statusCode: 400,
      code: 'MISSING_VALUE',
      message: 'A required value is missing.',
    },
  ],
  [
    // invalid_text_representation
    '22P02',
    {
      statusCode: 400,
      code: 'INVALID_VALUE_FORMAT',
      message: 'One of the values is malformed; identifiers must be uuids.',
    },
  ],
])

/**
 * The mapping for a database error code, or `null` for anything else —
 * including a SQLSTATE we chose not to map, which keeps the generic 500.
 *
 * A regular expression used to reject anything that did not look like a
 * SQLSTATE first. Every code it rejected the lookup rejects too, with one
 * exception that is the reason the table is a `Map` and not an object literal:
 * an object literal answers `SQLSTATE_MAP['toString']` with the inherited
 * function, which is truthy, so a `Map` — own keys only — is what makes the
 * shape check genuinely redundant rather than nearly so.
 */
export function mapSqlState(code: unknown): SqlStateMapping | null {
  if (typeof code !== 'string') return null
  return SQLSTATE_MAP.get(code) ?? null
}

/** Error envelope returned by the API. */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    statusCode: number
  }
}

/** Builds the error envelope in a uniform way. */
export function errorEnvelope(statusCode: number, code: string, message: string): ErrorEnvelope {
  return { error: { code, message, statusCode } }
}
