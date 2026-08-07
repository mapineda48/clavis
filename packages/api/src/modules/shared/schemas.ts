// Native Fastify JSON Schemas shared by every module.
//
// They are used both to validate the input (ajv) and to serialize the output
// (fast-json-stringify): a field that is not declared under `response` is dropped.

/** Global API error envelope: `{ error: { code, message, statusCode } }`. */
export const ErrorResponse = {
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
