import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
// `pg` is CommonJS: under ESM only the default import works.
import pg from 'pg'
import type { Client as PgClient } from 'pg'

const { Client } = pg

/**
 * Home-grown schema migrator, no external dependencies.
 *
 * - Files live in `packages/api/migrations` and are applied in lexicographic
 *   order. New files are named `YYYYMMDDHHMMSS_description.sql`; `0001_init.sql`
 *   keeps its historical name and must never be renamed (see below).
 * - Every migration runs inside its own transaction.
 * - The sha256 of each file is stored: if an already applied migration changes,
 *   startup aborts with an explanatory error.
 * - A PostgreSQL *advisory lock* prevents two API instances from migrating at
 *   the same time.
 *
 * Migrations are looked up by **filename** and there is no reverse check inside
 * a file, so renaming an applied migration makes the migrator see a brand new
 * one: it re-runs the whole file against a schema that already has it, and
 * leaves the old row behind. The drift check below turns that into a startup
 * error instead of a mystery.
 */

/** Fixed identifier of the advisory lock (arbitrary but stable). */
const MIGRATION_LOCK_ID = 726351940

/**
 * Bounded wait for the migration lock: roughly a minute, one log line per try.
 *
 * `pg_advisory_lock` waits forever, which is the worst possible behaviour here
 * — a lock left behind by a crashed peer stops every instance from ever
 * starting, and the only symptom is silence after "PostgreSQL is accepting
 * connections". Failing loudly after a bounded wait is recoverable; hanging
 * with no output is not.
 */
const LOCK_ATTEMPTS = 60
const LOCK_RETRY_MS = 1000

/** How the migration connection identifies itself in `pg_stat_activity`. */
const MIGRATION_APPLICATION_NAME = 'clavis-api-migrator'

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

/** What the migrator needs to open its own connection. */
export interface MigrationOptions {
  connectionString: string
}

export interface MigrationFile {
  version: string
  fileName: string
  sql: string
  checksum: string
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
 * Takes the migration lock without ever blocking indefinitely.
 * `pg_try_advisory_lock` returns immediately, so each failed attempt is a log
 * line naming who we are waiting for rather than an unexplained pause.
 */
async function acquireLock(client: PgClient, logger: MigrationLogger): Promise<void> {
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt += 1) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [MIGRATION_LOCK_ID],
    )
    if (rows[0]?.locked === true) {
      if (attempt > 1) logger.info({ attempt, lockId: MIGRATION_LOCK_ID }, 'Migration lock acquired')
      return
    }
    logger.warn(
      { attempt, attempts: LOCK_ATTEMPTS, lockId: MIGRATION_LOCK_ID },
      'Another instance holds the migration lock; retrying',
    )
    await delay(LOCK_RETRY_MS)
  }

  throw new Error(
    `Could not acquire the migration advisory lock ${MIGRATION_LOCK_ID} after ` +
      `${LOCK_ATTEMPTS} attempts (${(LOCK_ATTEMPTS * LOCK_RETRY_MS) / 1000}s). ` +
      'Another instance is either migrating or holding the lock from a session that ' +
      'never ended. Look for it with: SELECT * FROM pg_locks WHERE locktype = ' +
      "'advisory';",
  )
}

/**
 * Aborts when the database records a migration whose file is not here.
 *
 * The loop below walks the files on disk and looks each one up among the
 * applied versions; without this check the opposite direction is invisible.
 * A recorded version with no file means the file was renamed or deleted, or
 * that this build is older than the database it is pointed at — all three are
 * situations where continuing applies an unknown delta to an unknown schema.
 */
export function assertNoDrift(files: MigrationFile[], applied: Map<string, string>): void {
  const onDisk = new Set(files.map((file) => file.version))
  const orphans = [...applied.keys()].filter((version) => !onDisk.has(version)).sort()
  if (orphans.length === 0) return

  throw new Error(
    `The database records migrations that no longer exist in this build: ${orphans.join(', ')}. ` +
      'Migrations are looked up by filename, so a renamed file also looks like this — and ' +
      'renaming one makes it run again against a schema that already has it. Restore the ' +
      'file under its recorded name, or point the API at the database this build belongs to. ' +
      'Deleting the row is only correct once you know which of the two happened.',
  )
}

/**
 * Applies the pending migrations. Safe to call on every startup.
 *
 * It opens and closes a **connection of its own** rather than borrowing one
 * from the application pool. `client.release()` does not reset session state,
 * so anything a migration `SET`s would leak into whatever request picks that
 * connection up next; here the session simply ends. It also keeps the pool's
 * `statement_timeout` and `idle_in_transaction_session_timeout` — tuned for
 * request-sized work — away from DDL that is legitimately allowed to take
 * minutes. Ending the session also releases the advisory lock, so there is no
 * unlock path that can be skipped.
 */
export async function runMigrations(
  options: MigrationOptions,
  logger: MigrationLogger,
): Promise<void> {
  const files = await loadMigrationFiles()
  if (files.length === 0) {
    logger.warn({ dir: MIGRATIONS_DIR.pathname }, 'No migration files found')
    return
  }

  const client = new Client({
    connectionString: options.connectionString,
    application_name: MIGRATION_APPLICATION_NAME,
  })
  await client.connect()

  try {
    await acquireLock(client, logger)

    await client.query('CREATE SCHEMA IF NOT EXISTS clavis')
    await client.query(`
      CREATE TABLE IF NOT EXISTS clavis.schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM clavis.schema_migrations',
    )
    const applied = new Map(rows.map((row) => [row.version, row.checksum]))

    assertNoDrift(files, applied)

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
          'INSERT INTO clavis.schema_migrations (version, checksum) VALUES ($1, $2)',
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
    // Ending the session releases every advisory lock it holds, so this is the
    // unlock as well as the disconnect.
    await client.end().catch(() => undefined)
  }
}
