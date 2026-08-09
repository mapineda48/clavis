import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorEnvelope, forbidden, mapSqlState } from '../src/lib/errors.js'

// A pg error carries no `statusCode`, so anything this mapper does not
// recognise comes back to the caller as 500 INTERNAL_ERROR: the caller's
// mistake reported as the server's fault, plus an alert for nobody.

describe('mapSqlState', () => {
  it('maps a unique violation to 409', () => {
    assert.deepEqual(mapSqlState('23505'), {
      statusCode: 409,
      code: 'ALREADY_EXISTS',
      message: 'A record with those values already exists.',
    })
  })

  it('maps the constraint violations this schema can actually raise', () => {
    assert.equal(mapSqlState('23503')?.statusCode, 409)
    assert.equal(mapSqlState('23514')?.statusCode, 400)
    assert.equal(mapSqlState('23502')?.statusCode, 400)
  })

  it('maps a malformed uuid path parameter to 400', () => {
    // `clavis.users.id` is a uuid, so GET /api/users/not-a-uuid reaches pg.
    assert.equal(mapSqlState('22P02')?.statusCode, 400)
    assert.equal(mapSqlState('22P02')?.code, 'INVALID_VALUE_FORMAT')
  })

  it('leaves an unmapped SQLSTATE alone, so it keeps the 500', () => {
    // 42P01 is undefined_table: a bug in the API, not in the request.
    assert.equal(mapSqlState('42P01'), null)
  })

  it('does not mistake an application or Node error code for a SQLSTATE', () => {
    assert.equal(mapSqlState('VALIDATION_ERROR'), null)
    assert.equal(mapSqlState('ERR_MODULE_NOT_FOUND'), null)
    assert.equal(mapSqlState('ECONNREFUSED'), null)
  })

  it('ignores anything that is not one of the codes it maps', () => {
    assert.equal(mapSqlState(undefined), null)
    assert.equal(mapSqlState(23505), null)
    assert.equal(mapSqlState('2350'), null)
    assert.equal(mapSqlState('235055'), null)
    // pg always reports SQLSTATE in upper case.
    assert.equal(mapSqlState('22p02'), null)
  })

  it('does not answer with something inherited from Object.prototype', () => {
    // The reason the table is a Map: an object literal answers
    // `map['toString']` with the inherited function, which is truthy, and the
    // error handler would then read `statusCode` off it and reply with
    // `undefined`.
    assert.equal(mapSqlState('toString'), null)
    assert.equal(mapSqlState('constructor'), null)
    assert.equal(mapSqlState('__proto__'), null)
  })

  it('never returns a message carrying schema internals', () => {
    for (const code of ['23505', '23503', '23514', '23502', '22P02']) {
      const message = mapSqlState(code)?.message ?? ''
      assert.ok(message.length > 0)
      assert.ok(!/clavis\./.test(message), `${code} leaks a schema name`)
      assert.ok(!/_key|_pkey|_fkey/.test(message), `${code} leaks a constraint name`)
    }
  })
})

// The envelope is the API's error contract: the SPA matches on `code`, and
// `details` is the machine-readable half a client can act on (which
// permission keys a 403 is missing). What matters is that the key is ABSENT,
// not `undefined`, when there is nothing to say — a client testing
// `'details' in error` must not see one that carries nothing.

describe('errorEnvelope', () => {
  it('builds the base envelope without a details key', () => {
    const envelope = errorEnvelope(404, 'NOT_FOUND', 'Resource not found.')
    assert.deepEqual(envelope, {
      error: { code: 'NOT_FOUND', message: 'Resource not found.', statusCode: 404 },
    })
    assert.ok(!('details' in envelope.error))
  })

  it('publishes details when the raiser attached them', () => {
    const envelope = errorEnvelope(403, 'FORBIDDEN', 'Not enough permissions.', {
      missing: ['users:create'],
    })
    assert.deepEqual(envelope, {
      error: {
        code: 'FORBIDDEN',
        message: 'Not enough permissions.',
        statusCode: 403,
        details: { missing: ['users:create'] },
      },
    })
  })

  it('does not write the key for an explicit undefined', () => {
    // `JSON.stringify` drops an undefined value anyway; writing it would
    // leave the declared interface and the wire disagreeing.
    const envelope = errorEnvelope(500, 'INTERNAL_ERROR', 'Internal server error.', undefined)
    assert.ok(!('details' in envelope.error))
  })

  it('keeps falsy details, which are still details', () => {
    for (const details of [null, 0, false, '']) {
      const envelope = errorEnvelope(400, 'BAD_REQUEST', 'Bad request.', details)
      assert.equal(envelope.error.details, details)
    }
  })

  it('carries what the AppError factories attach', () => {
    // The path the escalation guard in lib/access.ts and requirePermissions
    // in http/auth.ts both take.
    const error = forbidden('You cannot grant that.', 'FORBIDDEN', { missing: ['access:manage'] })
    const envelope = errorEnvelope(error.statusCode, error.code, error.message, error.details)
    assert.deepEqual(envelope.error.details, { missing: ['access:manage'] })
  })
})
