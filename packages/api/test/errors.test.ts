import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mapSqlState } from '../src/lib/errors.js'

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
