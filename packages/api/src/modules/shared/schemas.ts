// Native Fastify JSON Schemas shared by every module.
//
// They are used both to validate the input (ajv) and to serialize the output
// (fast-json-stringify): a field that is not declared under `response` is dropped.
import type { FastifyInstance } from 'fastify'

/** `$id` of the shared error envelope, and the name it gets in the document. */
const ERROR_RESPONSE_ID = 'ErrorResponse'

/** Global API error envelope: `{ error: { code, message, statusCode } }`. */
const errorEnvelope = {
  $id: ERROR_RESPONSE_ID,
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable error code' },
        message: { type: 'string', description: 'Human-readable message' },
        statusCode: { type: 'integer', description: 'HTTP status code' },
      },
    },
  },
}

/**
 * Registers the schemas every module refers to. Must run before the routes.
 *
 * Fastify only resolves a `$ref` against schemas it has been given, and it is
 * `addSchema` that both makes the reference resolvable and gets the definition
 * into `components/schemas` **once**. Referenced without it, the envelope was
 * copied in full into each of the twenty-odd places it appears in the emitted
 * OpenAPI document.
 */
export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema(errorEnvelope)
}

/** The error envelope, as a route's `response` entry refers to it. */
export const ErrorResponse = { $ref: `${ERROR_RESPONSE_ID}#` }

/**
 * The `response` entries for a set of error statuses:
 * `response: { 200: Something, ...errorResponses(401, 403, 404) }`.
 *
 * Declaring the statuses a route can actually answer is not decoration:
 * Fastify serializes each status with its own schema, and one that is missing
 * falls back to serializing whatever the handler returned.
 */
export function errorResponses(...statuses: number[]): Record<number, typeof ErrorResponse> {
  return Object.fromEntries(statuses.map((status) => [status, ErrorResponse]))
}
