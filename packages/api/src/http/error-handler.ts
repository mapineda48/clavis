import type { ErrorRequestHandler, RequestHandler } from 'express'
import { AppError, errorEnvelope, mapSqlState } from '../lib/errors.js'

/**
 * The not-found and error handlers: every error response of the API shares
 * the `{ error: { code, message, statusCode } }` envelope. Both are mounted
 * LAST in `app.ts` — Express dispatches in registration order, so anything
 * that falls through every router lands here.
 */

/** The shape of the errors `body-parser` (express.json) raises. */
interface HttpishError extends Error {
  statusCode?: unknown
  status?: unknown
  code?: unknown
  /** body-parser's discriminator, e.g. `entity.parse.failed`. */
  type?: unknown
}

/**
 * body-parser failures worth a precise answer instead of the generic branch.
 *
 * `entity.parse.failed` is malformed JSON — the same caller mistake as a
 * schema violation, so it shares the VALIDATION_ERROR code. The other two are
 * the body limit and an encoding this API never accepts.
 */
const BODY_PARSER_MAP: ReadonlyMap<string, { statusCode: number; code: string; message: string }> =
  new Map([
    [
      'entity.parse.failed',
      {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data (body: malformed JSON).',
      },
    ],
    [
      'entity.too.large',
      {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body exceeds the size limit.',
      },
    ],
    [
      'charset.unsupported',
      {
        statusCode: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'The request body must be UTF-8 encoded JSON.',
      },
    ],
    [
      'encoding.unsupported',
      {
        statusCode: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'The request body must be UTF-8 encoded JSON.',
      },
    ],
  ])

/** Answers 404 with the envelope for any route no router claimed. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(errorEnvelope(404, 'ROUTE_NOT_FOUND', `Route not found: ${req.method} ${req.originalUrl}`))
}

/**
 * Global error handler. The four arguments are the signature Express
 * recognises an error middleware by; the last one stays even though only the
 * headers-sent bailout uses it.
 */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  // Too late to change the response: hand over to Express' default handler,
  // which closes the connection.
  if (res.headersSent) {
    next(error)
    return
  }

  const url = req.originalUrl

  // 1) Errors raised by the application itself (including validation).
  if (error instanceof AppError) {
    const logPayload = { err: error, code: error.code, url }
    if (error.statusCode >= 500) req.log.error(logPayload, error.message)
    else req.log.warn(logPayload, error.message)
    res.status(error.statusCode).json(errorEnvelope(error.statusCode, error.code, error.message))
    return
  }

  const httpish = error instanceof Error ? (error as HttpishError) : null

  // 2) Body parsing: malformed JSON, the size limit, an unsupported encoding.
  const bodyMapping = typeof httpish?.type === 'string' ? BODY_PARSER_MAP.get(httpish.type) : undefined
  if (bodyMapping !== undefined) {
    req.log.warn({ err: error, url }, 'Request body rejected')
    res
      .status(bodyMapping.statusCode)
      .json(errorEnvelope(bodyMapping.statusCode, bodyMapping.code, bodyMapping.message))
    return
  }

  // 3) PostgreSQL errors: a constraint violation is a conflict or a bad
  //    request, never an internal error.
  const sqlState = mapSqlState(httpish?.code)
  if (sqlState !== null) {
    req.log.warn(
      { err: error, sqlstate: httpish?.code, url },
      'Database constraint rejected the request',
    )
    res
      .status(sqlState.statusCode)
      .json(errorEnvelope(sqlState.statusCode, sqlState.code, sqlState.message))
    return
  }

  // 4) Express or middleware errors that already carry a known 4xx status
  //    (a malformed percent-encoding in the path, for instance).
  const rawStatus = httpish?.statusCode ?? httpish?.status
  const statusCode = typeof rawStatus === 'number' && rawStatus >= 400 ? rawStatus : 500
  if (statusCode < 500 && httpish !== null) {
    const code =
      typeof httpish.code === 'string' && httpish.code.length > 0 ? httpish.code : 'BAD_REQUEST'
    req.log.warn({ err: error, url }, httpish.message)
    res.status(statusCode).json(errorEnvelope(statusCode, code, httpish.message))
    return
  }

  // 5) Anything else: 500 without leaking internal details to the client.
  req.log.error({ err: error, url }, 'Unhandled error')
  res.status(500).json(errorEnvelope(500, 'INTERNAL_ERROR', 'Internal server error.'))
}
