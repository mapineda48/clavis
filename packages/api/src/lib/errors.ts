import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Error de aplicación con código HTTP y código simbólico.
 * El manejador global lo traduce al sobre `{ error: { code, message, statusCode } }`.
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

/** 400 — la petición es inválida o incoherente. */
export function badRequest(message: string, code = 'BAD_REQUEST', details?: unknown): AppError {
  return new AppError(400, code, message, details)
}

/** 401 — falta el token o no es válido. */
export function unauthorized(
  message = 'Se requiere un token de acceso válido.',
  code = 'UNAUTHENTICATED',
  details?: unknown,
): AppError {
  return new AppError(401, code, message, details)
}

/** 403 — el token es válido pero faltan permisos. */
export function forbidden(
  message = 'No tienes permisos suficientes para esta operación.',
  code = 'FORBIDDEN',
  details?: unknown,
): AppError {
  return new AppError(403, code, message, details)
}

/** 404 — el recurso no existe (o no es visible para el usuario). */
export function notFound(message = 'Recurso no encontrado.', code = 'NOT_FOUND', details?: unknown): AppError {
  return new AppError(404, code, message, details)
}

/** 409 — conflicto con el estado actual del recurso. */
export function conflict(message: string, code = 'CONFLICT', details?: unknown): AppError {
  return new AppError(409, code, message, details)
}

/** Sobre de error que devuelve la API. */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    statusCode: number
  }
}

/** Construye el sobre de error de forma homogénea. */
function envelope(statusCode: number, code: string, message: string): ErrorEnvelope {
  return { error: { code, message, statusCode } }
}

/** Nombre del campo afectado por un error de ajv, si se puede determinar. */
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

/** Convierte los errores de validación de ajv en un mensaje legible. */
function formatValidationError(error: FastifyError): string {
  const context = error.validationContext ? `${error.validationContext}: ` : ''
  const issues = (error.validation ?? [])
    .map((issue) => {
      const field = validationFieldName(issue)
      const detail = issue.message ?? 'valor inválido'
      return field ? `${field} ${detail}` : detail
    })
    .join('; ')

  return `Datos de la petición inválidos (${context}${issues || 'formato incorrecto'}).`
}

/**
 * Instala el manejador de errores global y el de rutas no encontradas.
 * Todas las respuestas de error de la API comparten el mismo sobre.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // 1) Errores de validación de esquema (ajv) -> 400 VALIDATION_ERROR
    if (error.validation) {
      const message = formatValidationError(error)
      request.log.warn({ err: error, url: request.url }, 'Petición inválida')
      return reply.code(400).type('application/json').send(envelope(400, 'VALIDATION_ERROR', message))
    }

    // 2) Errores propios de la aplicación
    if (error instanceof AppError) {
      const logPayload = { err: error, code: error.code, url: request.url }
      if (error.statusCode >= 500) request.log.error(logPayload, error.message)
      else request.log.warn(logPayload, error.message)
      return reply
        .code(error.statusCode)
        .type('application/json')
        .send(envelope(error.statusCode, error.code, error.message))
    }

    // 3) Errores de Fastify o de plugins con código HTTP conocido (4xx)
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500
    if (statusCode < 500) {
      const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : 'BAD_REQUEST'
      request.log.warn({ err: error, url: request.url }, error.message)
      return reply
        .code(statusCode)
        .type('application/json')
        .send(envelope(statusCode, code, error.message))
    }

    // 4) Cualquier otra cosa: 500 sin filtrar detalles internos al cliente
    request.log.error({ err: error, url: request.url }, 'Error no controlado')
    return reply
      .code(500)
      .type('application/json')
      .send(envelope(500, 'INTERNAL_ERROR', 'Error interno del servidor.'))
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(404)
      .type('application/json')
      .send(envelope(404, 'ROUTE_NOT_FOUND', `Ruta no encontrada: ${request.method} ${request.url}`))
  })
}
