import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, loadConfig } from '../src/config/env.js'

// `loadConfig` is a pure function of the environment it is handed. These tests
// exist as much to keep it that way as to check the parsing: the moment it
// reads `process.env` or exits, every one of them stops being possible.

describe('loadConfig', () => {
  it('fills in the development defaults for an empty environment', () => {
    const config = loadConfig({})
    assert.equal(config.NODE_ENV, 'development')
    assert.equal(config.HOST, '0.0.0.0')
    assert.equal(config.PORT, 3000)
    assert.equal(config.LOG_LEVEL, 'info')
    assert.equal(config.CACHE_TTL_SECONDS, 60)
    assert.equal(config.MAIL_ENABLED, true)
    assert.equal(config.RESEND_API_KEY, undefined)
  })

  it('reads only the environment it is given', () => {
    const config = loadConfig({ ROOT_USERNAME: 'somebody-else' })
    assert.equal(config.ROOT_USERNAME, 'somebody-else')
  })

  it('treats an empty variable as absent', () => {
    // Docker compose substitutes an empty string for anything missing from the
    // .env, and that has to mean "not configured", not "configured as empty".
    const config = loadConfig({ LOG_LEVEL: '', RESEND_API_KEY: '   ' })
    assert.equal(config.LOG_LEVEL, 'info')
    assert.equal(config.RESEND_API_KEY, undefined)
  })

  it('accepts API_PORT, and lets PORT win when both are set', () => {
    assert.equal(loadConfig({ API_PORT: '4000' }).PORT, 4000)
    assert.equal(loadConfig({ PORT: '5000', API_PORT: '4000' }).PORT, 5000)
  })

  it('splits CORS_ORIGINS, trimming and dropping the empty entries', () => {
    const config = loadConfig({ CORS_ORIGINS: 'http://a.test , ,http://b.test ' })
    assert.deepEqual(config.CORS_ORIGINS, ['http://a.test', 'http://b.test'])
  })

  it('reads booleans written as text', () => {
    assert.equal(loadConfig({ MAIL_ENABLED: 'false' }).MAIL_ENABLED, false)
    assert.equal(loadConfig({ MAIL_ENABLED: 'no' }).MAIL_ENABLED, false)
    assert.equal(loadConfig({ MAIL_ENABLED: '0' }).MAIL_ENABLED, false)
    assert.equal(loadConfig({ MAIL_ENABLED: 'ON' }).MAIL_ENABLED, true)
  })

  it('coerces the pool timeouts, and accepts 0 as "no timeout"', () => {
    const config = loadConfig({
      DB_STATEMENT_TIMEOUT_MS: '2500',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
      DB_CONNECTION_TIMEOUT_MS: '1500',
    })
    assert.equal(config.DB_STATEMENT_TIMEOUT_MS, 2500)
    assert.equal(config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 0)
    assert.equal(config.DB_CONNECTION_TIMEOUT_MS, 1500)
  })

  it('gives the connection wait a bounded default', () => {
    // The failure this rules out is a pool with no timer at all: callers queue
    // forever and the requests simply never answer.
    assert.ok(loadConfig({}).DB_CONNECTION_TIMEOUT_MS > 0)
  })

  it('throws instead of exiting when a value is wrong', () => {
    assert.throws(() => loadConfig({ PORT: 'http' }), ConfigError)
    assert.throws(() => loadConfig({ LOG_LEVEL: 'chatty' }), ConfigError)
    assert.throws(() => loadConfig({ ROOT_PASSWORD: 'short' }), ConfigError)
  })

  it('names every offending variable, not just the first', () => {
    try {
      loadConfig({ PORT: 'http', LOG_LEVEL: 'chatty' })
      assert.fail('expected a ConfigError')
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.issues.length, 2)
      assert.ok(error.issues.some((issue) => issue.includes('PORT')))
      assert.ok(error.issues.some((issue) => issue.includes('LOG_LEVEL')))
    }
  })

  it('reports in the format main.ts prints on stderr', () => {
    try {
      loadConfig({ PORT: 'http' })
      assert.fail('expected a ConfigError')
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      const lines = error.report().split('\n')
      assert.equal(lines[0], '')
      assert.equal(lines[1], '[@clavis/api] Invalid environment configuration:')
      assert.ok(lines[2]?.includes('PORT'))
      assert.equal(lines.at(-1), '')
    }
  })
})
