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

    // 3) Fastify or plugin errors that already carry a known 4xx status
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (statusCode < 500) {
      const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'BAD_REQUEST'
      request.log.warn({ err: error, url: request.url }, error.message)
      return reply
        .code(statusCode)
        .type('application/json')
        .send(envelope(statusCode, code, error.message))
    }

    // 4) Anything else: 500 without leaking internal details to the client
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
