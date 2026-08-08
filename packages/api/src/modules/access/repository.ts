// SQL layer of the access module. The service owns the flow; this owns the
// queries. Every function takes an `Executor` and never opens a transaction:
// the caller decides whether a statement runs on its own (`db`) or inside a
// transaction it already started (`client`). See `lib/executor.ts`.
import type { Executor } from '../../lib/executor.js'

/** A permission catalog row, as published by GET /access/catalog. */
export interface PermissionRow {
  key: string
  module: string
  description: string
}

/** A role with its resolved permission set. */
export interface RoleRow {
  slug: string
  name: string
  description: string | null
  is_system: boolean
  permissions: string[]
}

/** The role fields the guards need before any edit. */
export interface RoleHead {
  name: string
  description: string | null
  is_system: boolean
}

/** One per-user exception, as stored and as published. */
export interface OverrideRow {
  permission_key: string
  effect: 'grant' | 'revoke'
}

export async function listPermissions(db: Executor): Promise<PermissionRow[]> {
  const result = await db.query<PermissionRow>(
    `SELECT key, module, description FROM clavis.permissions ORDER BY module, key`,
  )
  return result.rows
}

export async function listRoles(db: Executor): Promise<RoleRow[]> {
  const result = await db.query<RoleRow>(
    `SELECT r.slug,
            r.name,
            r.description,
            r.is_system,
            COALESCE(
              (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key)
                 FROM clavis.role_permissions rp
                WHERE rp.role_slug = r.slug),
              '{}'
            ) AS permissions
       FROM clavis.roles r
      ORDER BY r.is_system DESC, r.slug ASC`,
  )
  return result.rows
}

export async function findRole(db: Executor, slug: string): Promise<RoleHead | null> {
  const result = await db.query<RoleHead>(
    `SELECT name, description, is_system FROM clavis.roles WHERE slug = $1`,
    [slug],
  )
  return result.rows[0] ?? null
}

/** `null` when the user does not exist. */
export async function isRootUser(db: Executor, userId: string): Promise<boolean | null> {
  const result = await db.query<{ is_root: boolean }>(
    `SELECT is_root FROM clavis.users WHERE id = $1`,
    [userId],
  )
  return result.rows[0]?.is_root ?? null
}

export async function listOverrides(db: Executor, userId: string): Promise<OverrideRow[]> {
  const result = await db.query<OverrideRow>(
    `SELECT permission_key, effect
       FROM clavis.user_permission_overrides
      WHERE user_id = $1
      ORDER BY permission_key`,
    [userId],
  )
  return result.rows
}

/** Which of `keys` are not in the permission catalog. */
export async function unknownPermissions(db: Executor, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return []
  const result = await db.query<{ key: string }>(
    `SELECT key FROM clavis.permissions WHERE key = ANY($1::text[])`,
    [keys],
  )
  const existing = new Set(result.rows.map((row) => row.key))
  return keys.filter((key) => !existing.has(key))
}

/**
 * Replaces the full override set of one user.
 * Two statements that belong together: run it inside a `tx`.
 */
export async function replaceOverrides(
  db: Executor,
  userId: string,
  actorId: string,
  overrides: { permissionKey: string; effect: 'grant' | 'revoke' }[],
): Promise<void> {
  await db.query(`DELETE FROM clavis.user_permission_overrides WHERE user_id = $1`, [userId])
  if (overrides.length > 0) {
    await db.query(
      `INSERT INTO clavis.user_permission_overrides (user_id, permission_key, effect, created_by)
       SELECT $1, o.key, o.effect, $2
         FROM unnest($3::text[], $4::text[]) AS o(key, effect)`,
      [
        userId,
        actorId,
        overrides.map((override) => override.permissionKey),
        overrides.map((override) => override.effect),
      ],
    )
  }
}

export async function insertRole(
  db: Executor,
  role: { slug: string; name: string; description: string | null },
): Promise<void> {
  await db.query(`INSERT INTO clavis.roles (slug, name, description) VALUES ($1, $2, $3)`, [
    role.slug,
    role.name,
    role.description,
  ])
}

/**
 * Replaces the permission set of a role.
 * Two statements that belong together: run it inside a `tx`.
 */
export async function replaceRolePermissions(
  db: Executor,
  slug: string,
  permissions: string[],
): Promise<void> {
  await db.query(`DELETE FROM clavis.role_permissions WHERE role_slug = $1`, [slug])
  await insertRolePermissions(db, slug, permissions)
}

export async function insertRolePermissions(
  db: Executor,
  slug: string,
  permissions: string[],
): Promise<void> {
  if (permissions.length === 0) return
  await db.query(
    `INSERT INTO clavis.role_permissions (role_slug, permission_key)
     SELECT $1, unnest($2::text[])`,
    [slug, permissions],
  )
}

/** Deletes the role; its assignments cascade away. */
export async function deleteRole(db: Executor, slug: string): Promise<void> {
  await db.query(`DELETE FROM clavis.roles WHERE slug = $1`, [slug])
}
