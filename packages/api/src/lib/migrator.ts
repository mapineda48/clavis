import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { Pool } from 'pg'

/**
 * Home-grown schema migrator, no external dependencies.
 *
 * - Files live in `packages/api/migrations` and are applied in lexicographic
 *   order (`0001_init.sql`, `0002_views.sql`, ...).
 * - Every migration runs inside its own transaction.
 * - The sha256 of each file is stored: if an already applied migration changes,
 *   startup aborts with an explanatory error.
 * - A PostgreSQL *advisory lock* prevents two API instances from migrating at
 *   the same time.
 */

/** Fixed identifier of the advisory lock (arbitrary but stable). */
const MIGRATION_LOCK_ID = 726351940

/**
 * Migrations folder, relative to this module.
 * Works the same in `src/lib/` (tsx) and in `dist/lib/` (compiled): in both
 * cases it is two levels up to the package root.
 */
const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)

/** The subset of the Fastify logger that the migrator needs. */
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

/** Reads and sorts the `.sql` files in the migrations folder. */
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
 * Applies the pending migrations. Safe to call on every startup.
 */
export async function runMigrations(pool: Pool, logger: MigrationLogger): Promise<void> {
  const files = await loadMigrationFiles()
  if (files.length === 0) {
    logger.warn({ dir: MIGRATIONS_DIR.pathname }, 'No migration files found')
    return
  }

  const client = await pool.connect()
  let lockAcquired = false

  try {
    // Session-level lock: a second instance waits right here.
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
            `Migration "${file.fileName}" is already applied but its content changed ` +
              `(recorded checksum ${previousChecksum}, current ${file.checksum}). ` +
              'Applied migrations are immutable: add a new file instead of editing this one, ' +
              'or reset the database with `make reset` if you are in development.',
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
          `Failed to apply migration "${file.fileName}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        )
      }

      appliedCount += 1
      logger.info({ version: file.version, checksum: file.checksum }, 'Migration applied')
    }

    if (appliedCount === 0) {
      logger.info({ total: files.length }, 'Schema up to date: no pending migrations')
    } else {
      logger.info({ applied: appliedCount, total: files.length }, 'Migrations completed')
    }
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]).catch(() => undefined)
    }
    client.release()
  }
}
