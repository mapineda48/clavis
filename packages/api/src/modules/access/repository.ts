// SQL layer of the access module. The service owns the flow; this owns the
// queries. Every function takes an `Executor` and never opens a transaction:
// the caller decides whether a statement runs on its own (`db`) or inside a
// transaction it already started (`client`). See `lib/executor.ts`.
import { type PermissionKey, isPermissionKey } from '@clavis/shared'
import type { CanonicalUserId } from '../../lib/access.js'
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

/** What the overrides writer has to know about the user it is about to edit. */
export interface OverrideTarget {
  id: CanonicalUserId
  isRoot: boolean
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

/**
 * Looks up the target of an overrides write.
 *
 * The `id::text` is the whole reason this is a function and not an inline
 * query: PostgreSQL matched the row on **uuid** equality, which ignores case
 * and accepts the brace and unhyphenated spellings, so the parameter the caller
 * sent is not necessarily the id the row has. Only the value coming back is,
 * and only that value may be compared against the caller's own id.
 */
export async function findOverrideTarget(
  db: Executor,
  id: string,
): Promise<OverrideTarget | null> {
  const result = await db.query<{ id: string; is_root: boolean }>(
    `SELECT id::text, is_root FROM clavis.users WHERE id = $1`,
    [id],
  )
  const row = result.rows[0]
  if (!row) return null
  return { id: row.id as CanonicalUserId, isRoot: row.is_root }
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

/** A user's existing override rows, split by effect. */
export interface CurrentOverrides {
  grants: string[]
  revokes: string[]
}

/**
 * The user's existing override rows, split by effect.
 *
 * The overrides guard is stated over the change to the *effective* set, so it
 * needs both halves: the grants AND the revokes. A revoke masks a role
 * permission, so dropping one — an omission from the full-replace body, not a
 * submitted grant — unmasks that permission, and the guard only sees it if it
 * knows the revoke was there. Read on the same executor as the write, so the
 * "before" it feeds is the state the write is actually replacing.
 */
export async function currentOverrides(
  db: Executor,
  userId: CanonicalUserId,
): Promise<CurrentOverrides> {
  const result = await db.query<{ permission_key: string; effect: 'grant' | 'revoke' }>(
    `SELECT permission_key, effect
       FROM clavis.user_permission_overrides
      WHERE user_id = $1`,
    [userId],
  )
  const grants: string[] = []
  const revokes: string[] = []
  for (const row of result.rows) {
    ;(row.effect === 'grant' ? grants : revokes).push(row.permission_key)
  }
  return { grants, revokes }
}

/**
 * The deduplicated union of the permissions those roles carry.
 *
 * Assigning a role is an indirect grant: it adds every key the role holds to
 * the first branch of the effective union. `assertMayGrant` is stated over
 * keys, so the two `users:*` writers that touch `user_roles` have to resolve
 * the roles into keys before they can ask it anything.
 *
 * `isPermissionKey` cannot drop a row in practice — `role_permissions` has a
 * foreign key onto `clavis.permissions`, which boot syncs to exactly
 * `PERMISSION_DEFS` — and is here so the return type is checked rather than
 * asserted, the same reason `loadAccessContext` filters.
 */
export async function permissionsForRoles(
  db: Executor,
  slugs: string[],
): Promise<PermissionKey[]> {
  if (slugs.length === 0) return []
  const result = await db.query<{ permission_key: string }>(
    `SELECT DISTINCT permission_key
       FROM clavis.role_permissions
      WHERE role_slug = ANY($1::text[])
      ORDER BY permission_key`,
    [slugs],
  )
  return result.rows.map((row) => row.permission_key).filter(isPermissionKey)
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
 * Locks the user row for the length of the caller's transaction.
 *
 * The overrides writer takes it first: it serialises two administrators
 * editing THIS user's overrides at once — otherwise the second write silently
 * discards the first, a lost update independent of security — and it pins the
 * target's own grants/revokes so the reads that follow cannot shift under a
 * concurrent override edit of the same user.
 */
export async function lockUserRow(db: Executor, userId: CanonicalUserId): Promise<void> {
  await db.query(`SELECT 1 FROM clavis.users WHERE id = $1 FOR UPDATE`, [userId])
}

/**
 * Replaces the full override set of one user.
 * Two statements that belong together: run it inside a `tx`.
 */
export async function replaceOverrides(
  db: Executor,
  userId: CanonicalUserId,
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
