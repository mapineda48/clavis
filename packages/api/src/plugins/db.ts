import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
// `pg` es CommonJS: bajo ESM sólo funciona la importación por defecto.
import pg from 'pg'
import type { Pool as PgPool } from 'pg'
import { env } from '../config/env.js'
import { runMigrations } from '../lib/migrator.js'

const { Pool } = pg

/** Intentos y espera entre reintentos de la primera conexión. */
const CONNECT_ATTEMPTS = 10
const CONNECT_RETRY_MS = 1500

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Espera a que PostgreSQL acepte conexiones.
 * El healthcheck de docker compose ya ordena el arranque, pero un reintento
 * acotado evita que un reinicio de la base tumbe la API.
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
        'PostgreSQL todavía no acepta conexiones; reintentando',
      )
      await delay(CONNECT_RETRY_MS)
    }
  }
}

/**
 * Plugin de base de datos: crea el pool de PostgreSQL, ejecuta las migraciones
 * pendientes durante el arranque y decora `fastify.db`.
 */
export const dbPlugin = fp(
  async (app: FastifyInstance) => {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      application_name: 'erp-api',
    })

    // El pool emite errores de los clientes inactivos: se registran para que un
    // corte de red con PostgreSQL no tumbe el proceso.
    pool.on('error', (error) => {
      app.log.error({ err: error }, 'Error inesperado en un cliente del pool de PostgreSQL')
    })

    await waitForDatabase(pool, app)
    await runMigrations(pool, app.log)

    const db: FastifyInstance['db'] = {
      pool,

      async query(text, params) {
        // Sin parámetros se usa el protocolo simple (permite varias sentencias).
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
          app.log.warn({ err: error }, 'PostgreSQL no responde')
          return false
        }
      },
    }

    app.decorate('db', db)

    app.addHook('onClose', async () => {
      await pool.end().catch(() => undefined)
      app.log.info('Pool de PostgreSQL cerrado')
    })
  },
  { name: 'erp-db' },
)

export default dbPlugin
