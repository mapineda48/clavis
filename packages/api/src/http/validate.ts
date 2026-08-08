import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import addFormatsExport from 'ajv-formats'
import type { Request, RequestHandler } from 'express'
import { badRequest } from '../lib/errors.js'

// ajv-formats is transpiled CommonJS (`exports.__esModule` + `exports.default`):
// Node's interop hands the plugin function itself to the default binding, while
// TypeScript under NodeNext types that binding as the whole module namespace —
// the same class of trap as ioredis' non-constructible default export. Accept
// either shape once, here, instead of fighting the checker at the call site.
const addFormatsCandidate: unknown = addFormatsExport
const addFormats = (
  typeof addFormatsCandidate === 'function'
    ? addFormatsCandidate
    : (addFormatsCandidate as { default: unknown }).default
) as (ajv: Ajv) => Ajv

/**
 * Request validation with Ajv, compiled once per route at registration.
 *
 * The options mirror what Fastify configured for the same schemas, so the
 * behaviour survived the framework change: strings arriving in `req.query`
 * and `req.params` are coerced to the declared types, declared `default`s are
 * filled in, and properties a body declares `additionalProperties: false`
 * against are silently stripped rather than rejected.
 *
 * Validation only ever covers the REQUEST. Response schemas are documentation
 * (see `http/openapi.ts`): nothing filters what a handler sends, which is why
 * every response goes through a serializer whose field list is asserted
 * against the schema in the unit tests.
 */
const ajv = new Ajv({
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: true,
  allErrors: false,
})
addFormats(ajv)

/** The request segments a route can declare schemas for. */
export interface RouteValidation {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: Record<string, unknown>
}

type Segment = keyof RouteValidation

const SEGMENTS: readonly Segment[] = ['params', 'query', 'body']

/** Name of the field an ajv error refers to, when it can be determined. */
function validationFieldName(issue: ErrorObject): string {
  if (issue.instancePath.length > 0) {
    return issue.instancePath.replace(/^\//, '').replace(/\//g, '.')
  }
  const missing = (issue.params as Record<string, unknown>)['missingProperty']
  if (typeof missing === 'string') return missing
  return ''
}

/** Turns ajv validation errors into a readable message. */
export function formatValidationErrors(
  segment: string,
  issues: readonly ErrorObject[] | null | undefined,
): string {
  const detail = (issues ?? [])
    .map((issue) => {
      const field = validationFieldName(issue)
      const message = issue.message ?? 'invalid value'
      return field ? `${field} ${message}` : message
    })
    .join('; ')

  return `Invalid request data (${segment}: ${detail || 'malformed payload'}).`
}

interface CompiledCheck {
  segment: Segment
  fn: ValidateFunction
}

/**
 * Middleware validating (and normalising) the declared request segments.
 *
 * Every segment is validated against a **plain copy**, which is then written
 * back over the request property. The copy is not caution for its own sake:
 * Express 5 exposes `req.query` through a getter that re-parses the URL, so a
 * coercion or default applied in place would evaporate on the next read, and
 * assigning the property raises on the getter. `Object.defineProperty` shadows
 * it with the validated value, so every later read — in the handler or in
 * another middleware — sees exactly what the schema accepted.
 */
export function validate(schemas: RouteValidation): RequestHandler {
  const checks: CompiledCheck[] = SEGMENTS.flatMap((segment) => {
    const schema = schemas[segment]
    return schema ? [{ segment, fn: ajv.compile(schema) }] : []
  })

  return function validateRequest(req: Request, _res, next) {
    for (const { segment, fn } of checks) {
      const raw: unknown = req[segment]
      // A body only exists when the client sent parseable JSON; validating
      // `undefined` against the object schema produces the right refusal. The
      // other segments always exist as (possibly empty) objects.
      const data: unknown =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : raw

      if (!fn(data)) {
        throw badRequest(formatValidationErrors(segment, fn.errors), 'VALIDATION_ERROR')
      }

      Object.defineProperty(req, segment, {
        value: data,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    next()
  }
}
