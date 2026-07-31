import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { Pool } from 'pg'

/**
 * Migrador de esquema propio, sin dependencias externas.
 *
 * - Los ficheros viven en `packages/api/migrations` y se aplican en orden
 *   lexicográfico (`0001_init.sql`, `0002_views.sql`, ...).
 * - Cada migración se aplica dentro de su propia transacción.
 * - Se guarda el sha256 del fichero: si una migración ya aplicada cambia, se
 *   aborta el arranque con un error explicativo.
 * - Un *advisory lock* de PostgreSQL evita que dos instancias de la API
 *   migren a la vez.
 */

/** Identificador fijo del advisory lock (arbitrario pero estable). */
const MIGRATION_LOCK_ID = 726351940

/**
 * Carpeta de migraciones relativa a este módulo.
 * Funciona igual en `src/lib/` (tsx) y en `dist/lib/` (compilado): en ambos
 * casos hay que subir dos niveles hasta la raíz del paquete.
 */
const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)

/** Subconjunto del logger de Fastify que necesita el migrador. */
export interface MigrationLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
}

interface MigrationFile {
  version: string
  fileName: string
  sql: string
  checksum: string
}

/** Lee y ordena los ficheros `.sql` de la carpeta de migraciones. */
async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR)
  const fileNames = entries
    .filter((name) => name.toLowerCase().endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const files: MigrationFile[] = []
  for (const fileName of fileNames) {
    const sql = await readFile(new URL(fileName, MIGRATIONS_DIR), 'utf8')
    files.push({
      version: fileName.replace(/\.sql$/i, ''),
      fileName,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    })
  }
  return files
}

/**
 * Aplica las migraciones pendientes. Es seguro llamarla en cada arranque.
 */
export async function runMigrations(pool: Pool, logger: MigrationLogger): Promise<void> {
  const files = await loadMigrationFiles()
  if (files.length === 0) {
    logger.warn({ dir: MIGRATIONS_DIR.pathname }, 'No se encontraron ficheros de migración')
    return
  }

  const client = await pool.connect()
  let lockAcquired = false

  try {
    // Bloqueo a nivel de sesión: la segunda instancia espera aquí.
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID])
    lockAcquired = true

    await client.query('CREATE SCHEMA IF NOT EXISTS erp')
    await client.query(`
      CREATE TABLE IF NOT EXISTS erp.schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM erp.schema_migrations',
    )
    const applied = new Map(rows.map((row) => [row.version, row.checksum]))

    let appliedCount = 0

    for (const file of files) {
      const previousChecksum = applied.get(file.version)

      if (previousChecksum !== undefined) {
        if (previousChecksum !== file.checksum) {
          throw new Error(
            `La migración "${file.fileName}" ya está aplicada pero su contenido cambió ` +
              `(checksum registrado ${previousChecksum}, actual ${file.checksum}). ` +
              'Las migraciones aplicadas son inmutables: crea un fichero nuevo en lugar de editarla, ' +
              'o reinicia la base de datos con `make reset` si estás en desarrollo.',
          )
        }
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(file.sql)
        await client.query(
          'INSERT INTO erp.schema_migrations (version, checksum) VALUES ($1, $2)',
          [file.version, file.checksum],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw new Error(
          `Fallo al aplicar la migración "${file.fileName}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        )
      }

      appliedCount += 1
      logger.info({ version: file.version, checksum: file.checksum }, 'Migración aplicada')
    }

    if (appliedCount === 0) {
      logger.info({ total: files.length }, 'Esquema al día: no hay migraciones pendientes')
    } else {
      logger.info({ applied: appliedCount, total: files.length }, 'Migraciones completadas')
    }
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]).catch(() => undefined)
    }
    client.release()
  }
}
