import express from 'express'
import type { Router } from 'express'
import { getAbsoluteFSPath } from 'swagger-ui-dist'
import type { AppConfig } from '../config/env.js'
import type { ModuleDef, RouteDef } from './route.js'

/**
 * The OpenAPI document and the UI that serves it, both derived from the same
 * `ModuleDef` list the routers are built from. There is no annotation to keep
 * in sync with the code: a route that exists is documented, a guard that is
 * wired is the one published, and a module missing from `MODULES` (app.ts)
 * is missing from both the server and the docs at once.
 */

/** Where the documentation lives; exported so the mount and the URLs cannot drift. */
export const DOCS_PATH = '/api/docs'

/** Name of the shared error envelope in `components/schemas`. */
const ERROR_RESPONSE_NAME = 'ErrorResponse'

/**
 * Global API error envelope: `{ error: { code, message, statusCode } }`, plus
 * the optional `details`.
 *
 * `details` carries no `type`: its shape belongs to the `code` that produced
 * it (a 403 from the escalation guard lists the missing permission keys, a
 * validation error would list fields), so declaring one here would document a
 * contract the API does not keep. Only errors the application raised ever
 * carry it — see `http/error-handler.ts`.
 */
const errorEnvelopeSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable error code' },
        message: { type: 'string', description: 'Human-readable message' },
        statusCode: { type: 'integer', description: 'HTTP status code' },
        details: {
          description:
            'Optional machine-readable context for this error. Present only when the ' +
            'error code defines one; its shape depends on that code.',
        },
      },
      required: ['code', 'message', 'statusCode'],
    },
  },
}

/**
 * The error envelope, as a route's `responses` entry refers to it.
 *
 * Not exported: every route reaches it through `errorResponses(...)` below, and
 * an exported alternative is an invitation to hand-build the map again.
 */
const ErrorResponseRef = { $ref: `#/components/schemas/${ERROR_RESPONSE_NAME}` }

/**
 * The `responses` entries for a set of error statuses:
 * `responses: { 200: Something, ...errorResponses(401, 403, 404) }`.
 */
export function errorResponses(...statuses: number[]): Record<number, typeof ErrorResponseRef> {
  return Object.fromEntries(statuses.map((status) => [status, ErrorResponseRef]))
}

/** Reason phrases for the statuses this API answers with. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
}

/** The subset of a JSON Schema object the parameter builder reads. */
interface ObjectSchema {
  properties?: Record<string, unknown>
  required?: string[]
}

/** Path/query parameters from a segment schema (`in: 'path' | 'query'`). */
function parametersFrom(schema: Record<string, unknown> | undefined, where: 'path' | 'query') {
  const shape = schema as ObjectSchema | undefined
  if (!shape?.properties) return []
  const required = new Set(shape.required ?? [])
  return Object.entries(shape.properties).map(([name, propSchema]) => ({
    name,
    in: where,
    // Path parameters are required by construction: Express does not match
    // the route without them.
    required: where === 'path' ? true : required.has(name),
    schema: propSchema,
  }))
}

/** `/users/:id` → `/users/{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}

/** One OpenAPI response object; 204 carries no content by definition. */
function responseFor(status: number, schema: unknown) {
  const description = STATUS_TEXT[status] ?? `HTTP ${status}`
  if (status === 204) return { description }
  return { description, content: { 'application/json': { schema } } }
}

/** The OpenAPI operation for one route definition. */
function operationFor(tagName: string, def: RouteDef) {
  return {
    tags: [tagName],
    summary: def.summary,
    ...(def.description !== undefined ? { description: def.description } : {}),
    // Derived from the SAME field the middleware stack is wired from: a
    // public route documents no requirement, everything else demands the
    // bearer token.
    security: def.permissions === null ? [] : [{ bearerAuth: [] }],
    parameters: [
      ...parametersFrom(def.schema?.params, 'path'),
      ...parametersFrom(def.schema?.query, 'query'),
    ],
    ...(def.schema?.body !== undefined
      ? { requestBody: { required: true, content: { 'application/json': { schema: def.schema.body } } } }
      : {}),
    responses: Object.fromEntries(
      Object.entries(def.responses).map(([status, schema]) => [
        status,
        responseFor(Number(status), schema),
      ]),
    ),
  }
}

/**
 * The slice of the configuration the document may read.
 *
 * Nothing reads it today — the server list became relative — but the
 * parameter stays: `app.ts` passes the whole configuration, so keeping it is
 * free, and the next document field that does depend on the environment adds
 * itself here instead of changing the signature and its call site.
 */
export type OpenApiOptions = Pick<AppConfig, 'PORT'>

/** Assembles the whole OpenAPI 3.1 document from the module list. */
export function buildOpenApiDocument(_options: OpenApiOptions, modules: readonly ModuleDef[]) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const module of modules) {
    for (const def of module.routes) {
      const path = `/api${toOpenApiPath(def.path)}`
      paths[path] ??= {}
      paths[path][def.method] = operationFor(module.tag.name, def)
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Clavis API',
      description:
        'Access-control API: it validates the Keycloak token on every request and ' +
        'resolves what the caller is allowed to do.',
      version: '1.0.0',
    },
    // A RELATIVE server URL, resolved by the client against wherever the
    // document was served from. The absolute `http://localhost:PORT` it
    // replaces was only ever right on a developer's machine: behind the
    // reverse proxy the docs page published a base URL that no browser
    // outside that host could reach, so every "Try it out" aimed at the
    // reader's own machine. One entry, correct in both places.
    servers: [{ url: '/', description: 'This origin' }],
    tags: modules.map((module) => module.tag),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token issued by Keycloak for the clavis-api audience.',
        },
      },
      schemas: {
        [ERROR_RESPONSE_NAME]: errorEnvelopeSchema,
      },
    },
    paths,
  }
}

/**
 * The page is written by hand instead of shipping `swagger-ui-dist`'s
 * `index.html`: that file loads its assets by RELATIVE path, which resolves
 * against `/api/` when the browser asks for `/api/docs` without a trailing
 * slash — and answering that with a redirect would break the deployment's
 * plain `GET /api/docs` check. Absolute URLs make both spellings serve the
 * same 200.
 */
function docsIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clavis API documentation</title>
  <link rel="stylesheet" href="${DOCS_PATH}/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${DOCS_PATH}/swagger-ui-bundle.js"></script>
  <script src="${DOCS_PATH}/swagger-initializer.js"></script>
</body>
</html>
`
}

/** The initializer swagger-ui loads; mirrors the old @fastify/swagger-ui options. */
function docsInitializerJs(): string {
  return `window.onload = () => {
  window.ui = SwaggerUIBundle({
    url: '${DOCS_PATH}/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'list',
    persistAuthorization: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
  })
}
`
}

/**
 * Router serving the documentation: the page, the initializer, the document
 * itself and the swagger-ui assets. Mounted at `DOCS_PATH` — under /api like
 * everything else the API serves: in production a single reverse-proxy rule
 * sends /api to this service and everything else to the SPA, so a path
 * outside /api would be answered by the SPA instead.
 */
export function createDocsRouter(document: unknown): Router {
  const router = express.Router()
  const html = docsIndexHtml()
  const initializer = docsInitializerJs()

  router.get('/', (_req, res) => {
    res.type('html').send(html)
  })
  router.get('/openapi.json', (_req, res) => {
    res.json(document)
  })
  // Served before the static assets so ours wins over the petstore-pointing
  // one the package ships.
  router.get('/swagger-initializer.js', (_req, res) => {
    res.type('application/javascript').send(initializer)
  })
  router.use(express.static(getAbsoluteFSPath(), { index: false }))

  return router
}
