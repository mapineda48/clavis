import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Application error carrying an HTTP status and a symbolic code.
 * The global handler turns it into the `{ error: { code, message, statusCode } }`
 * envelope.
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
const SQLSTATE_MAP: Readonly<Record<string, SqlStateMapping>> = {
  // unique_violation
  '23505': {
    statusCode: 409,
    code: 'ALREADY_EXISTS',
    message: 'A record with those values already exists.',
  },
  // foreign_key_violation
  '23503': {
    statusCode: 409,
    code: 'REFERENCE_CONFLICT',
    message:
      'The operation references a record that does not exist, or one that is still referenced elsewhere.',
  },
  // check_violation
  '23514': {
    statusCode: 400,
    code: 'VALUE_NOT_ALLOWED',
    message: 'One of the values is not among those this field accepts.',
  },
  // not_null_violation
  '23502': {
    statusCode: 400,
    code: 'MISSING_VALUE',
    message: 'A required value is missing.',
  },
  // invalid_text_representation
  '22P02': {
    statusCode: 400,
    code: 'INVALID_VALUE_FORMAT',
    message: 'One of the values is malformed; identifiers must be uuids.',
  },
}

/**
 * A SQLSTATE is exactly five alphanumerics (`23505`, `22P02`). Fastify codes
 * (`FST_ERR_*`) and Node's (`ERR_*`) never match, so the shape alone is enough
 * to tell a database error from any other one carrying a `code`.
 */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/

/**
 * The mapping for a database error code, or `null` for anything else —
 * including a SQLSTATE we chose not to map, which keeps the generic 500.
 */
export function mapSqlState(code: unknown): SqlStateMapping | null {
  if (typeof code !== 'string' || !SQLSTATE_PATTERN.test(code)) return null
  return SQLSTATE_MAP[code] ?? null
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
function envelope(statusCode: number, code: string, message: string): ErrorEnvelope {
  return { error: { code, message, statusCode } }
}

/** Name of the field an ajv error refers to, when it can be determined. */
function validationFieldName(issue: { instancePath?: string; params?: unknown }): string {
  if (typeof issue.instancePath === 'string' && issue.instancePath.length > 0) {
    return issue.instancePath.replace(/^\//, '').replace(/\//g, '.')
  }
  if (typeof issue.params === 'object' && issue.params !== null) {
    const missing = (issue.params as Record<string, unknown>)['missingProperty']
    if (typeof missing === 'string') return missing
  }
  return ''
}

/** Turns ajv validation errors into a readable message. */
function formatValidationError(error: FastifyError): string {
  const context = error.validationContext ? `${error.validationContext}: ` : ''
  const issues = (error.validation ?? [])
    .map((issue) => {
      const field = validationFieldName(issue)
      const detail = issue.message ?? 'invalid value'
      return field ? `${field} ${detail}` : detail
    })
    .join('; ')

  return `Invalid request data (${context}${issues || 'malformed payload'}).`
}

/**
 * Installs the global error handler and the not-found handler.
 * Every error response of the API shares the same envelope.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // 1) Schema validation errors (ajv) -> 400 VALIDATION_ERROR
    if (error.validation) {
      const message = formatValidationError(error)
      request.log.warn({ err: error, url: request.url }, 'Invalid request')
      return reply.code(400).type('application/json').send(envelope(400, 'VALIDATION_ERROR', message))
    }

    // 2) Errors raised by the application itself
    if (error instanceof AppError) {
      const logPayload = { err: error, code: error.code, url: request.url }
      if (error.statusCode >= 500) request.log.error(logPayload, error.message)
      else request.log.warn(logPayload, error.message)
      return reply
        .code(error.statusCode)
        .type('application/json')
        .send(envelope(error.statusCode, error.code, error.message))
    }

    // 3) PostgreSQL errors: a constraint violation is a conflict or a bad
    //    request, never an internal error.
    const sqlState = mapSqlState(error.code)
    if (sqlState !== null) {
      request.log.warn(
        { err: error, sqlstate: error.code, url: request.url },
        'Database constraint rejected the request',
      )
      return reply
        .code(sqlState.statusCode)
        .type('application/json')
        .send(envelope(sqlState.statusCode, sqlState.code, sqlState.message))
    }

    // 4) Fastify or plugin errors that already carry a known 4xx status
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (statusCode < 500) {
      const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'BAD_REQUEST'
      request.log.warn({ err: error, url: request.url }, error.message)
      return reply
        .code(statusCode)
        .type('application/json')
        .send(envelope(statusCode, code, error.message))
    }

    // 5) Anything else: 500 without leaking internal details to the client
    request.log.error({ err: error, url: request.url }, 'Unhandled error')
    return reply
      .code(500)
      .type('application/json')
      .send(envelope(500, 'INTERNAL_ERROR', 'Internal server error.'))
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(404)
      .type('application/json')
      .send(envelope(404, 'ROUTE_NOT_FOUND', `Route not found: ${request.method} ${request.url}`))
  })
}
