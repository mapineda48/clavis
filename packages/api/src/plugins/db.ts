import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
// `pg` is CommonJS: under ESM only the default import works.
import pg from 'pg'
import type { Pool as PgPool } from 'pg'
import type { AppConfig } from '../config/env.js'
import { runMigrations } from '../lib/migrator.js'

const { Pool } = pg

/** The slice of the configuration this plugin reads. */
export type DbPluginOptions = Pick<
  AppConfig,
  | 'DATABASE_URL'
  | 'DB_STATEMENT_TIMEOUT_MS'
  | 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'
  | 'DB_CONNECTION_TIMEOUT_MS'
>

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
      // A checkout against a saturated pool has no timer of its own: without
      // this, `pool.connect()` waits forever and the failure looks like
      // requests that simply never answer. `waitForDatabase` below borrows it
      // too, which is the behaviour it wants — a bounded attempt it can retry
      // and log rather than one long silence.
      connectionTimeoutMillis: options.DB_CONNECTION_TIMEOUT_MS,
      // Every connection starts with the two timeouts in force. `onConnect` is
      // AWAITED by the pool before the connection is handed to whoever asked
      // for it, which the `connect` event is not: a listener there races the
      // first query and pg 8 answers it with a deprecation warning.
      //
      // The settings are sent as ordinary statements rather than as `-c`
      // startup options on purpose. A connection pooler in front of PostgreSQL
      // may refuse a startup parameter it does not know — that fails the
      // connection outright — while a `SET` it decides to reset just leaves the
      // timeout unapplied. Degrading beats not connecting.
      onConnect: async (client) => {
        await client.query(`SET statement_timeout = ${options.DB_STATEMENT_TIMEOUT_MS}`)
        await client.query(
          `SET idle_in_transaction_session_timeout = ${options.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
        )
      },
    })

    // The pool emits errors coming from idle clients: they are logged so that a
    // network glitch with PostgreSQL does not crash the process.
    pool.on('error', (error) => {
      app.log.error({ err: error }, 'Unexpected error on a PostgreSQL pool client')
    })

    app.log.info(
      {
        statementTimeoutMs: options.DB_STATEMENT_TIMEOUT_MS,
        idleInTransactionTimeoutMs: options.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
        connectionTimeoutMs: options.DB_CONNECTION_TIMEOUT_MS,
      },
      'PostgreSQL pool timeouts configured',
    )

    await waitForDatabase(pool, app)
    // The migrator opens its own connection from the same URL: nothing it does
    // to its session can reach a request, and the pool's timeouts do not reach
    // its DDL. See `lib/migrator.ts`.
    await runMigrations({ connectionString: options.DATABASE_URL }, app.log)

    const db: FastifyInstance['db'] = {
      pool,

      async query(text, params) {
        // Without parameters the simple protocol is used (allows several statements).
        return params === undefined ? pool.query(text) : pool.query(text, params)
      },

      async tx(fn) {
        const client = await pool.connect()
        // Set only when the ROLLBACK itself failed; handed to `release()` below.
        let rollbackError: Error | undefined
        // While a client is checked out the pool takes its own `error` listener
        // off, and a transaction sitting between two statements has no query to
        // deliver a failure to. So a FATAL that arrives right then — the
        // idle-in-transaction timeout above, an administrative terminate, a
        // dropped connection — surfaces as an unhandled `error` event, which is
        // a process-wide crash. Logging it turns the worst outcome into the
        // statement that follows rejecting, which the caller already handles.
        const onError = (error: Error): void => {
          app.log.error({ err: error }, 'PostgreSQL connection lost during a transaction')
        }
        client.on('error', onError)
        try {
          await client.query('BEGIN')
          const result = await fn(client)
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch((failure: unknown) => {
            // Swallowing this and releasing the client clean is how a
            // connection goes back into the idle pool still inside an aborted
            // transaction: pg-pool only destroys a client when `release` is
            // handed an error or the client is no longer queryable, and a
            // ROLLBACK can fail on a socket that is very much still alive. The
            // next checkout would then answer 25P02 to every statement, on a
            // request that did nothing wrong. Remember it and destroy instead.
            rollbackError = failure instanceof Error ? failure : new Error(String(failure))
            app.log.error({ err: failure }, 'ROLLBACK failed; discarding the connection')
          })
          throw error
        } finally {
          client.removeListener('error', onError)
          // A client the server has terminated is no longer `_queryable`, and
          // the pool discards it on release instead of handing it out again.
          // `undefined` is the same as no argument: the normal path is unchanged.
          client.release(rollbackError)
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
