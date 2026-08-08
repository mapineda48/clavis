import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import { errorHandler, notFoundHandler } from '../src/http/error-handler.js'
import { AppError } from '../src/lib/errors.js'

// The error handler is the whole error contract of the API: every refusal a
// client sees goes through it, and the SPA and the verification suite match
// on the envelope's `code`. What these tests pin is the routing — which kind
// of failure lands in which branch — because a branch reordering compiles
// clean and changes public behaviour.

interface Sent {
  status: number | null
  body: unknown
  nextCalledWith: unknown
  logged: { level: 'warn' | 'error'; msg: string }[]
}

function dispatch(error: unknown, options: { headersSent?: boolean } = {}): Sent {
  const sent: Sent = { status: null, body: null, nextCalledWith: undefined, logged: [] }

  const req = {
    method: 'GET',
    originalUrl: '/api/users?limit=5',
    log: {
      warn: (_obj: unknown, msg: string) => sent.logged.push({ level: 'warn', msg }),
      error: (_obj: unknown, msg: string) => sent.logged.push({ level: 'error', msg }),
    },
  } as unknown as Request

  const res = {
    headersSent: options.headersSent ?? false,
    status(code: number) {
      sent.status = code
      return this
    },
    json(body: unknown) {
      sent.body = body
      return this
    },
  } as unknown as Response

  const next: NextFunction = (value?: unknown) => {
    sent.nextCalledWith = value
  }

  errorHandler(error, req, res, next)
  return sent
}

/** The envelope's error object, asserted to exist. */
function envelopeOf(sent: Sent): { code: string; message: string; statusCode: number } {
  const body = sent.body as { error?: { code: string; message: string; statusCode: number } }
  assert.ok(body?.error, 'the response must carry the error envelope')
  return body.error
}

describe('errorHandler', () => {
  it('maps an AppError to its own status and code', () => {
    const sent = dispatch(new AppError(403, 'SELF_MODIFICATION', 'You cannot do that.'))
    assert.equal(sent.status, 403)
    assert.deepEqual(envelopeOf(sent), {
      code: 'SELF_MODIFICATION',
      message: 'You cannot do that.',
      statusCode: 403,
    })
    assert.equal(sent.logged[0]?.level, 'warn')
  })

  it('logs a 5xx AppError as an error, not a warning', () => {
    const sent = dispatch(new AppError(502, 'KEYCLOAK_ERROR', 'Keycloak refused.'))
    assert.equal(sent.status, 502)
    assert.equal(sent.logged[0]?.level, 'error')
  })

  it('answers malformed JSON with 400 VALIDATION_ERROR', () => {
    // body-parser flags its failures with `type`, not with a class.
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      statusCode: 400,
    })
    const sent = dispatch(error)
    assert.equal(sent.status, 400)
    assert.equal(envelopeOf(sent).code, 'VALIDATION_ERROR')
  })

  it('answers an oversized body with 413 PAYLOAD_TOO_LARGE', () => {
    const error = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      statusCode: 413,
    })
    const sent = dispatch(error)
    assert.equal(sent.status, 413)
    assert.equal(envelopeOf(sent).code, 'PAYLOAD_TOO_LARGE')
  })

  it('maps a recognised SQLSTATE instead of answering 500', () => {
    const error = Object.assign(new Error('duplicate key value'), { code: '23505' })
    const sent = dispatch(error)
    assert.equal(sent.status, 409)
    assert.equal(envelopeOf(sent).code, 'ALREADY_EXISTS')
    // The pg detail names constraint and value; the envelope must not.
    assert.ok(!envelopeOf(sent).message.includes('duplicate key'))
  })

  it('keeps the status of an error that already carries a 4xx', () => {
    const error = Object.assign(new Error('Failed to decode param'), { statusCode: 400 })
    const sent = dispatch(error)
    assert.equal(sent.status, 400)
    assert.equal(envelopeOf(sent).code, 'BAD_REQUEST')
  })

  it('answers 500 INTERNAL_ERROR for anything unrecognised, without leaking it', () => {
    const sent = dispatch(new Error('connection refused at 10.0.0.7:5432'))
    assert.equal(sent.status, 500)
    assert.deepEqual(envelopeOf(sent), {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
      statusCode: 500,
    })
    assert.equal(sent.logged[0]?.level, 'error')
  })

  it('delegates to Express once headers are sent', () => {
    const error = new AppError(400, 'X', 'y')
    const sent = dispatch(error, { headersSent: true })
    assert.equal(sent.status, null)
    assert.equal(sent.nextCalledWith, error)
  })
})

describe('notFoundHandler', () => {
  it('answers 404 ROUTE_NOT_FOUND naming the method and path', () => {
    const sent: Sent = { status: null, body: null, nextCalledWith: undefined, logged: [] }
    const req = { method: 'PATCH', originalUrl: '/api/nope' } as unknown as Request
    const res = {
      status(code: number) {
        sent.status = code
        return this
      },
      json(body: unknown) {
        sent.body = body
        return this
      },
    } as unknown as Response

    notFoundHandler(req, res, (() => undefined) as NextFunction)
    assert.equal(sent.status, 404)
    assert.equal(envelopeOf(sent).code, 'ROUTE_NOT_FOUND')
    assert.match(envelopeOf(sent).message, /PATCH \/api\/nope/)
  })
})
