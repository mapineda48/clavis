import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
// `pg` is CommonJS: under ESM only the default import works.
import pg from 'pg'
import type { Pool as PgPool } from 'pg'
import type { AppConfig } from '../config/env.js'
import { runMigrations } from '../lib/migrator.js'

const { Pool } = pg

/** The slice of the configuration this plugin reads. */
export type DbPluginOptions = Pick<AppConfig, 'DATABASE_URL'>

/** Attempts and wait between retries of the very first connection. */
const CONNECT_ATTEMPTS = 10
const CONNECT_RETRY_MS = 1500

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until PostgreSQL accepts connections.
 * The docker compose healthcheck already orders the startup, but a bounded
 * retry keeps a database restart from taking the API down.
 */
async function waitForDatabase(pool: PgPool, app: FastifyInstance): Promise<void> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const client = await pool.connect()
      client.release()
      return
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error
      app.log.warn(
        { attempt, attempts: CONNECT_ATTEMPTS, err: error },
        'PostgreSQL is not accepting connections yet; retrying',
      )
      await delay(CONNECT_RETRY_MS)
    }
  }
}

/**
 * Database plugin: creates the PostgreSQL pool, runs the pending migrations
 * during startup and decorates `fastify.db`.
 */
export const dbPlugin = fp<DbPluginOptions>(
  async (app: FastifyInstance, options) => {
    const pool = new Pool({
      connectionString: options.DATABASE_URL,
      max: 10,
      application_name: 'clavis-api',
    })

    // The pool emits errors coming from idle clients: they are logged so that a
    // network glitch with PostgreSQL does not crash the process.
    pool.on('error', (error) => {
      app.log.error({ err: error }, 'Unexpected error on a PostgreSQL pool client')
    })

    await waitForDatabase(pool, app)
    await runMigrations(pool, app.log)

    const db: FastifyInstance['db'] = {
      pool,

      async query(text, params) {
        // Without parameters the simple protocol is used (allows several statements).
        return params === undefined ? pool.query(text) : pool.query(text, params)
      },

      async tx(fn) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await fn(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      },

      async ping() {
        try {
          await pool.query('SELECT 1')
          return true
        } catch (error) {
          app.log.warn({ err: error }, 'PostgreSQL is not responding')
          return false
        }
      },
    }

    app.decorate('db', db)

    app.addHook('onClose', async () => {
      await pool.end().catch(() => undefined)
      app.log.info('PostgreSQL pool closed')
    })
  },
  { name: 'clavis-db' },
)

export default dbPlugin
