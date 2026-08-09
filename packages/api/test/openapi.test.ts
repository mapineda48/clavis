import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOpenApiDocument, errorResponses } from '../src/http/openapi.js'
import type { ModuleDef } from '../src/http/route.js'

// The OpenAPI document is derived from the same ModuleDef list the routers
// are built from — that is the whole design. What these tests pin is the
// derivation itself: the path syntax conversion, and above all that the
// `security` section comes from `permissions`, the field that also wires the
// middleware. A document that promised a guard the route does not run would
// be worse than no document.

const noop = async (): Promise<void> => undefined

function fakeModules(): ModuleDef[] {
  return [
    {
      tag: { name: 'health', description: 'Health' },
      routes: [
        {
          method: 'get',
          path: '/health',
          summary: 'Liveness',
          permissions: null,
          responses: { 200: { type: 'object' } },
          handler: noop,
        },
      ],
    },
    {
      tag: { name: 'users', description: 'Users' },
      routes: [
        {
          method: 'get',
          path: '/users',
          summary: 'List',
          permissions: ['users:read'],
          schema: {
            query: {
              type: 'object',
              properties: { limit: { type: 'integer', default: 100 } },
            },
          },
          responses: { 200: { type: 'object' }, ...errorResponses(401, 403) },
          handler: noop,
        },
        {
          method: 'delete',
          path: '/users/:id',
          summary: 'Delete',
          permissions: ['users:delete'],
          schema: {
            params: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string', minLength: 1 } },
            },
          },
          responses: { 204: { type: 'null' }, ...errorResponses(401, 403, 404) },
          handler: noop,
        },
      ],
    },
  ]
}

type AnyDoc = Record<string, any>

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument({ PORT: 3000 }, fakeModules()) as AnyDoc

  it('publishes every route under /api with OpenAPI path syntax', () => {
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/api/health', '/api/users', '/api/users/{id}'])
    assert.ok(doc.paths['/api/users/{id}'].delete)
  })

  it('derives the security section from the same field that wires the middleware', () => {
    // permissions: null → public; anything else → bearer token required.
    assert.deepEqual(doc.paths['/api/health'].get.security, [])
    assert.deepEqual(doc.paths['/api/users'].get.security, [{ bearerAuth: [] }])
  })

  it('lists the tags in module order', () => {
    assert.deepEqual(
      doc.tags.map((tag: { name: string }) => tag.name),
      ['health', 'users'],
    )
  })

  it('turns the params schema into required path parameters', () => {
    const parameters = doc.paths['/api/users/{id}'].delete.parameters
    assert.deepEqual(parameters, [
      { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } },
    ])
  })

  it('turns the query schema into optional query parameters', () => {
    const parameters = doc.paths['/api/users'].get.parameters
    assert.deepEqual(parameters, [
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 100 } },
    ])
  })

  it('publishes the shared error envelope once and refers to it by $ref', () => {
    assert.ok(doc.components.schemas.ErrorResponse)
    const response = doc.paths['/api/users'].get.responses['401']
    assert.deepEqual(response.content['application/json'].schema, {
      $ref: '#/components/schemas/ErrorResponse',
    })
  })

  it('documents details as the one optional field of the error envelope', () => {
    // The handler fills it only for errors the application raised, so a
    // client has to treat its absence as the normal case. It carries no
    // `type` on purpose: the shape belongs to the error code.
    const error = doc.components.schemas.ErrorResponse.properties.error
    assert.deepEqual(error.required, ['code', 'message', 'statusCode'])
    assert.ok(error.properties.details)
    assert.equal(error.properties.details.type, undefined)
    assert.equal(typeof error.properties.details.description, 'string')
  })

  it('publishes 204 without content, as the status demands', () => {
    const response = doc.paths['/api/users/{id}'].delete.responses['204']
    assert.equal(response.content, undefined)
    assert.equal(typeof response.description, 'string')
  })

  it('publishes a single relative server, not the local host', () => {
    // Resolved by the client against wherever the document was served from,
    // so the same document is right in dev and behind the production proxy.
    // An absolute http://localhost:PORT pointed every reader's "Try it out"
    // at their own machine.
    assert.deepEqual(doc.servers, [{ url: '/', description: 'This origin' }])
    for (const server of doc.servers) {
      assert.ok(!/^https?:/i.test(server.url), 'the server list must not hardcode an origin')
    }
  })
})

describe('errorResponses', () => {
  it('builds one $ref entry per status', () => {
    const responses = errorResponses(401, 403, 404)
    assert.deepEqual(Object.keys(responses), ['401', '403', '404'])
    for (const value of Object.values(responses)) {
      assert.deepEqual(value, { $ref: '#/components/schemas/ErrorResponse' })
    }
  })
})
