// SQL layer of the users module. Handlers own the flow; this owns the queries.
//
// Every function here takes an `Executor` and never opens a transaction: the
// caller decides whether the statement runs on its own (`app.db`) or inside a
// transaction it already started (`client`). See `lib/executor.ts`.
import type { CanonicalUserId } from '../../lib/access.js'
import type { Executor } from '../../lib/executor.js'

/** Application user with their assigned role slugs. */
export interface UserRecord {
  id: CanonicalUserId
  username: string
  email: string
  display_name: string | null
  is_root: boolean
  status: 'active' | 'disabled'
  created_at: Date | string
  last_seen_at: Date | string | null
  roles: string[]
}

/** The row as `pg` hands it over, before the id is branded. */
type UserRow = Omit<UserRecord, 'id'> & { id: string }

/**
 * Where a user id becomes a `CanonicalUserId` in this module (the access module
 * mints its own from `findOverrideTarget`).
 *
 * `USER_SELECT` reads `u.id::text`, so this is the spelling the column holds —
 * which is exactly what the brand claims and what `assertNotSelf` needs. Going
 * through `db.query<UserRecord>` directly would mint the brand invisibly, and
 * the point of the type is that minting it is visible.
 */
function toRecord(row: UserRow): UserRecord {
  return { ...row, id: row.id as CanonicalUserId }
}

const USER_SELECT = `
  SELECT u.id::text,
         u.username,
         u.email,
         u.display_name,
         u.is_root,
         u.status,
         u.created_at,
         u.last_seen_at,
         COALESCE(
           (SELECT array_agg(ur.role_slug ORDER BY ur.role_slug)
              FROM clavis.user_roles ur
             WHERE ur.user_id = u.id),
           '{}'
         ) AS roles
    FROM clavis.users u`

export async function listUsers(db: Executor, limit: number): Promise<UserRecord[]> {
  const result = await db.query<UserRow>(
    `${USER_SELECT}
     ORDER BY u.is_root DESC, u.username ASC
     LIMIT $1`,
    [limit],
  )
  return result.rows.map(toRecord)
}

export async function findUser(db: Executor, id: string): Promise<UserRecord | null> {
  const result = await db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id])
  const row = result.rows[0]
  return row === undefined ? null : toRecord(row)
}

/** Returns which of `slugs` do not exist as roles. */
export async function missingRoles(db: Executor, slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return []
  const result = await db.query<{ slug: string }>(
    `SELECT slug FROM clavis.roles WHERE slug = ANY($1::text[])`,
    [slugs],
  )
  const existing = new Set(result.rows.map((row) => row.slug))
  return slugs.filter((slug) => !existing.has(slug))
}

/** The field already taken by another user, if any. */
export async function takenField(
  db: Executor,
  email: string,
  username: string,
): Promise<'email' | 'username' | null> {
  const result = await db.query<{ email: string; username: string }>(
    `SELECT email, username FROM clavis.users WHERE email = $1 OR username = $2 LIMIT 1`,
    [email, username],
  )
  const row = result.rows[0]
  if (!row) return null
  return row.email === email ? 'email' : 'username'
}

export interface NewUser {
  id: string
  username: string
  email: string
  displayName: string
  roles: string[]
}

/**
 * Inserts the user and their role assignments.
 * Two statements that belong together, so the caller runs it inside a `tx`.
 */
export async function insertUser(db: Executor, user: NewUser): Promise<void> {
  await db.query(
    `INSERT INTO clavis.users (id, username, email, display_name)
     VALUES ($1, $2, $3, $4)`,
    [user.id, user.username, user.email, user.displayName],
  )
  await assignRoles(db, user.id, user.roles)
}

/** Replaces the user's role set. Two statements: run it inside a `tx`. */
export async function replaceRoles(
  db: Executor,
  userId: string,
  roles: string[],
): Promise<void> {
  await db.query(`DELETE FROM clavis.user_roles WHERE user_id = $1`, [userId])
  await assignRoles(db, userId, roles)
}

async function assignRoles(db: Executor, userId: string, roles: string[]): Promise<void> {
  if (roles.length === 0) return
  await db.query(
    `INSERT INTO clavis.user_roles (user_id, role_slug)
     SELECT $1, unnest($2::text[])
     ON CONFLICT DO NOTHING`,
    [userId, roles],
  )
}
