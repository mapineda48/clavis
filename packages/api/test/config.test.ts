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

  it('gives the JSON body limit a default well below the upload ceiling', () => {
    // The two bound different resources: JSON is parsed on the event loop,
    // uploads stream past it. Sharing one number is what this rules out.
    const config = loadConfig({})
    assert.equal(config.JSON_BODY_LIMIT_BYTES, 131072)
    assert.ok(config.JSON_BODY_LIMIT_BYTES < config.MAX_UPLOAD_BYTES)
  })

  it('coerces JSON_BODY_LIMIT_BYTES and refuses it outside its range', () => {
    assert.equal(loadConfig({ JSON_BODY_LIMIT_BYTES: '4096' }).JSON_BODY_LIMIT_BYTES, 4096)
    assert.throws(() => loadConfig({ JSON_BODY_LIMIT_BYTES: '1023' }), ConfigError)
    assert.throws(() => loadConfig({ JSON_BODY_LIMIT_BYTES: '10485761' }), ConfigError)
    assert.throws(() => loadConfig({ JSON_BODY_LIMIT_BYTES: 'lots' }), ConfigError)
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

// The development defaults, spelled out here on purpose rather than imported
// from the module under test: a test that reads the same constant as the code
// agrees with any value that constant is changed to, including a bad one. These
// literals are what `.env.example` and docker compose actually carry.
const DEV_DEFAULT = {
  ROOT_PASSWORD: 'Root123!',
  KEYCLOAK_API_CLIENT_SECRET: 'clavis_api_dev_secret',
  DATABASE_URL: 'postgres://clavis:clavis_dev_password@localhost:5432/clavis',
  AZURE_STORAGE_CONNECTION_STRING:
    'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:8081',
} as const

/** What a production deployment is supposed to hand over: nothing defaulted. */
function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    ROOT_PASSWORD: 'an-operator-chosen-root-password',
    KEYCLOAK_API_CLIENT_SECRET: 'an-operator-chosen-client-secret',
    DATABASE_URL: 'postgres://clavis:chosen@db.example.test:5432/clavis',
    AZURE_STORAGE_CONNECTION_STRING:
      'DefaultEndpointsProtocol=https;AccountName=clavisprod;AccountKey=Y2hvc2Vu;EndpointSuffix=core.windows.net',
    CORS_ORIGINS: 'https://clavis.example.test',
    ...overrides,
  }
}

/** The issues of the ConfigError `env` must produce, or a failed assertion. */
function refusalIssues(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env)
    assert.fail('expected a ConfigError')
  } catch (error) {
    assert.ok(error instanceof ConfigError)
    return error.issues
  }
}

describe('loadConfig under NODE_ENV=production', () => {
  it('accepts a configuration where nothing is left at its default', () => {
    const config = loadConfig(productionEnv())
    assert.equal(config.NODE_ENV, 'production')
    assert.deepEqual(config.CORS_ORIGINS, ['https://clavis.example.test'])
  })

  for (const [variable, devValue] of Object.entries(DEV_DEFAULT)) {
    it(`refuses ${variable} left at its development default`, () => {
      const issues = refusalIssues(productionEnv({ [variable]: devValue }))
      assert.equal(issues.length, 1)
      assert.ok(issues[0]?.includes(variable))
      assert.ok(issues[0]?.includes('must be set explicitly in production'))
    })
  }

  it('refuses the value, not merely the absence of the variable', () => {
    // The way this happens is `.env.example` copied into a real environment:
    // every variable is set, and every one of them is set to the default.
    const issues = refusalIssues({ NODE_ENV: 'production', ...DEV_DEFAULT })
    assert.equal(issues.length, Object.keys(DEV_DEFAULT).length)
  })

  it('refuses the development database password on any host', () => {
    // Compose derives DATABASE_URL against host `postgres`, not `localhost`,
    // so an exact-match check would wave the dev credential through on every
    // host anyone actually deploys. The password is the part that matters.
    const issues = refusalIssues(
      productionEnv({
        DATABASE_URL: 'postgres://clavis:clavis_dev_password@db.prod.internal:5432/clavis',
      }),
    )
    assert.equal(issues.length, 1)
    assert.ok(issues[0]?.includes('DATABASE_URL'))
  })

  it('refuses Azurite credentials pointed at another host', () => {
    // What `.env.example` carries differs from the schema default only in the
    // host; the published account key is the part that matters.
    const issues = refusalIssues(
      productionEnv({
        AZURE_STORAGE_CONNECTION_STRING: DEV_DEFAULT.AZURE_STORAGE_CONNECTION_STRING.replaceAll(
          'localhost',
          'azurite',
        ),
      }),
    )
    assert.equal(issues.length, 1)
    assert.ok(issues[0]?.includes('AZURE_STORAGE_CONNECTION_STRING'))
  })

  it('lists every offending variable in one error, not one per restart', () => {
    const issues = refusalIssues(
      productionEnv({
        ROOT_PASSWORD: DEV_DEFAULT.ROOT_PASSWORD,
        KEYCLOAK_API_CLIENT_SECRET: DEV_DEFAULT.KEYCLOAK_API_CLIENT_SECRET,
        CORS_ORIGINS: DEV_DEFAULT.CORS_ORIGINS,
      }),
    )
    assert.equal(issues.length, 3)
    for (const variable of ['ROOT_PASSWORD', 'KEYCLOAK_API_CLIENT_SECRET', 'CORS_ORIGINS']) {
      assert.ok(issues.some((issue) => issue.includes(variable)))
    }
  })

  it('recognises the default CORS list however it was written', () => {
    // The check compares the parsed array, so the padding docker compose can
    // introduce does not launder the default past it.
    const issues = refusalIssues(
      productionEnv({ CORS_ORIGINS: ' http://localhost:5173 ,, http://localhost:8081 ' }),
    )
    assert.equal(issues.length, 1)
    assert.ok(issues[0]?.includes('CORS_ORIGINS'))
  })

  it('leaves development and test alone', () => {
    // The defaults exist so `pnpm dev` runs with nothing exported by hand;
    // refusing them outside production would only make that harder.
    for (const NODE_ENV of ['development', 'test']) {
      const config = loadConfig({ NODE_ENV })
      assert.equal(config.ROOT_PASSWORD, DEV_DEFAULT.ROOT_PASSWORD)
      assert.equal(config.KEYCLOAK_API_CLIENT_SECRET, DEV_DEFAULT.KEYCLOAK_API_CLIENT_SECRET)
      assert.equal(config.DATABASE_URL, DEV_DEFAULT.DATABASE_URL)
      assert.deepEqual(config.CORS_ORIGINS, ['http://localhost:5173', 'http://localhost:8081'])
    }
  })
})
