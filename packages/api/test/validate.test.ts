import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request, Response } from 'express'
import { validate } from '../src/http/validate.js'
import { AppError } from '../src/lib/errors.js'
import { ReplacePermissionsBody } from '../src/modules/access/schemas.js'
import { SlugParams } from '../src/modules/shared/params.js'
import { CreateUserBody, ListUsersQuery } from '../src/modules/users/schemas.js'

// The validation middleware inherited Fastify's ajv behaviour on purpose:
// query strings coerce to the declared types, defaults fill in, and a body
// property outside `additionalProperties: false` is stripped, not refused.
// These tests pin all three, because each one is invisible in a review — the
// route works either way until a client depends on the difference.

/** A request-shaped object the middleware can read and write. */
function fakeReq(parts: { params?: unknown; query?: unknown; body?: unknown }): Request {
  return { params: {}, query: {}, ...parts } as unknown as Request
}

const noopRes = {} as Response

/** Runs the middleware; returns the AppError it threw, or null. */
function run(middleware: ReturnType<typeof validate>, req: Request): AppError | null {
  let called = false
  try {
    middleware(req, noopRes, () => {
      called = true
    })
  } catch (error) {
    assert.ok(error instanceof AppError, 'validation must refuse with an AppError')
    return error
  }
  assert.ok(called, 'next() must be called when validation passes')
  return null
}

const LimitQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  },
}

describe('validate', () => {
  it('coerces query strings to the declared type', () => {
    // Everything in a query string arrives as text; the schema says integer.
    const req = fakeReq({ query: { limit: '42' } })
    assert.equal(run(validate({ query: LimitQuery }), req), null)
    assert.equal((req.query as { limit?: number }).limit, 42)
  })

  it('fills declared defaults in', () => {
    const req = fakeReq({ query: {} })
    assert.equal(run(validate({ query: LimitQuery }), req), null)
    assert.equal((req.query as { limit?: number }).limit, 100)
  })

  it('rejects a value outside the declared range with VALIDATION_ERROR', () => {
    const req = fakeReq({ query: { limit: '9999' } })
    const error = run(validate({ query: LimitQuery }), req)
    assert.ok(error)
    assert.equal(error.statusCode, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.match(error.message, /^Invalid request data \(query: /)
    assert.match(error.message, /limit/)
  })

  it('strips body properties outside additionalProperties: false, silently', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string' } },
    }
    const req = fakeReq({ body: { name: 'x', extra: 'dropped' } })
    assert.equal(run(validate({ body: schema }), req), null)
    assert.deepEqual(req.body, { name: 'x' })
  })

  it('names the missing property in the message', () => {
    const schema = {
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string' } },
    }
    const error = run(validate({ body: schema }), fakeReq({ body: {} }))
    assert.ok(error)
    assert.match(error.message, /email/)
  })

  it('refuses an absent body against a body schema', () => {
    // No parseable JSON arrived: req.body is undefined, and the schema wants
    // an object. The refusal must be a 400, not a crash on undefined.
    const schema = { type: 'object', properties: {} }
    const error = run(validate({ body: schema }), fakeReq({ body: undefined }))
    assert.ok(error)
    assert.equal(error.statusCode, 400)
    assert.match(error.message, /body/)
  })

  it('validates params and reports them under their segment name', () => {
    const schema = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1 } },
    }
    const error = run(validate({ params: schema }), fakeReq({ params: { id: '' } }))
    assert.ok(error)
    assert.match(error.message, /^Invalid request data \(params: /)
  })

  it('does not mutate the original query object, only the request property', () => {
    // Express 5 serves `req.query` from a getter that re-parses the URL, so
    // the middleware validates a copy and shadows the property. What must
    // hold: after validation, reading req.query returns the validated copy.
    const original: Record<string, unknown> = { limit: '7' }
    const req = fakeReq({ query: original })
    assert.equal(run(validate({ query: LimitQuery }), req), null)
    assert.equal((req.query as { limit?: number }).limit, 7)
    assert.equal(original['limit'], '7')
  })
})

// The ceilings, exercised through the REAL schemas rather than a copy of them:
// a copy would keep passing after the schema it copies has moved. Two things
// have to hold at once — the payloads the product actually sends are untouched,
// and the ones that only exist to be expensive are a 400 rather than a slow
// 200 that walks the list a lookup at a time.
describe('request schema ceilings', () => {
  const validUser = {
    email: 'verify.bot@clavis.local',
    displayName: 'Verification Bot',
    username: 'verify.bot',
    credentialMode: 'temporary_password',
    temporaryPassword: 's3cret-password',
  }

  function roleList(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `role-${index}`)
  }

  it('leaves a realistic create payload alone, default and all', () => {
    const req = fakeReq({ body: { ...validUser } })
    assert.equal(run(validate({ body: CreateUserBody }), req), null)
    assert.deepEqual(req.body, { ...validUser, roles: [] })
  })

  it('accepts a role list right up to the ceiling', () => {
    const req = fakeReq({ body: { ...validUser, roles: roleList(50) } })
    assert.equal(run(validate({ body: CreateUserBody }), req), null)
    assert.equal((req.body as { roles: string[] }).roles.length, 50)
  })

  it('refuses one role past the ceiling', () => {
    const req = fakeReq({ body: { ...validUser, roles: roleList(51) } })
    const error = run(validate({ body: CreateUserBody }), req)
    assert.ok(error)
    assert.equal(error.statusCode, 400)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.match(error.message, /roles/)
  })

  it('refuses a role name no column could hold', () => {
    const req = fakeReq({ body: { ...validUser, roles: ['r'.repeat(65)] } })
    const error = run(validate({ body: CreateUserBody }), req)
    assert.ok(error)
    assert.equal(error.statusCode, 400)
  })

  it('refuses a permission list past the ceiling', () => {
    const permissions = Array.from({ length: 201 }, (_, index) => `demo:${index}`)
    const error = run(validate({ body: ReplacePermissionsBody }), fakeReq({ body: { permissions } }))
    assert.ok(error)
    assert.equal(error.statusCode, 400)
    assert.match(error.message, /permissions/)
  })

  it('refuses a slug past the ceiling the role pattern already implies', () => {
    const error = run(validate({ params: SlugParams }), fakeReq({ params: { slug: 's'.repeat(65) } }))
    assert.ok(error)
    assert.equal(error.statusCode, 400)
  })

  it('still fills the listing default in, DTO binding and all', () => {
    // `ListUsersQuery` gained `required: []` when it was bound to its DTO.
    // Coercion and defaults are what that must not have disturbed.
    const req = fakeReq({ query: { junk: 'stripped' } })
    assert.equal(run(validate({ query: ListUsersQuery }), req), null)
    assert.deepEqual(req.query, { limit: 100 })
  })
})
