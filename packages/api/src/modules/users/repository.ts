// SQL layer of the users module. Handlers own the flow; this owns the queries.
import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'

type Database = FastifyInstance['db']

/** Application user with their assigned role slugs. */
export interface UserRecord {
  id: string
  username: string
  email: string
  display_name: string | null
  is_root: boolean
  status: 'active' | 'disabled'
  created_at: Date | string
  last_seen_at: Date | string | null
  roles: string[]
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

export async function listUsers(db: Database, limit: number): Promise<UserRecord[]> {
  const result = await db.query<UserRecord>(
    `${USER_SELECT}
     ORDER BY u.is_root DESC, u.username ASC
     LIMIT $1`,
    [limit],
  )
  return result.rows
}

export async function findUser(db: Database, id: string): Promise<UserRecord | null> {
  const result = await db.query<UserRecord>(`${USER_SELECT} WHERE u.id = $1`, [id])
  return result.rows[0] ?? null
}

/** Returns which of `slugs` do not exist as roles. */
export async function missingRoles(db: Database, slugs: string[]): Promise<string[]> {
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
  db: Database,
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

/** Inserts the user and their role assignments in one transaction. */
export async function insertUser(db: Database, user: NewUser): Promise<void> {
  await db.tx(async (client) => {
    await client.query(
      `INSERT INTO clavis.users (id, username, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [user.id, user.username, user.email, user.displayName],
    )
    await assignRoles(client, user.id, user.roles)
  })
}

/** Replaces the user's role set (inside a caller-provided transaction). */
export async function replaceRoles(
  client: PoolClient,
  userId: string,
  roles: string[],
): Promise<void> {
  await client.query(`DELETE FROM clavis.user_roles WHERE user_id = $1`, [userId])
  await assignRoles(client, userId, roles)
}

async function assignRoles(client: PoolClient, userId: string, roles: string[]): Promise<void> {
  if (roles.length === 0) return
  await client.query(
    `INSERT INTO clavis.user_roles (user_id, role_slug)
     SELECT $1, unnest($2::text[])
     ON CONFLICT DO NOTHING`,
    [userId, roles],
  )
}
