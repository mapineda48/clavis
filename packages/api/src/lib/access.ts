import { PERMISSION_KEYS, type PermissionKey, isPermissionKey } from '@clavis/shared'
import type { Executor } from './executor.js'

/**
 * Access resolution: who the user is for the application and what they may do.
 *
 * Keycloak authenticates; this module decides. The permission catalog lives in
 * code (@clavis/shared) and the ASSIGNMENTS live in Postgres:
 *
 *   effective = union(role permissions) ∪ grants − revokes
 *
 * `is_root` short-circuits to the full catalog before any of that runs.
 */

/** Application-side view of a user row. */
export interface AccessUser {
  id: string
  username: string
  email: string
  displayName: string | null
  isRoot: boolean
  status: 'active' | 'disabled'
}

/** What a request is allowed to do; cached per user under the `access` namespace. */
export interface AccessContext {
  user: AccessUser
  roles: string[]
  permissions: PermissionKey[]
}

/** Cache namespace for everything derived from roles/permissions/overrides. */
export const ACCESS_NAMESPACE = 'access'

/** Cache key of one user's resolved access, bound to the namespace version. */
export function accessCacheKey(version: number, userId: string): string {
  return `clavis:v${version}:${ACCESS_NAMESPACE}:user:${userId}`
}

interface AccessRow {
  id: string
  username: string
  email: string
  display_name: string | null
  is_root: boolean
  status: 'active' | 'disabled'
  roles: string[]
  permissions: string[] | null
}

/**
 * Loads a user's access context in one round trip.
 * Returns `null` when the user does not exist in `clavis.users` — an
 * authenticated identity without a provisioned application user.
 */
export async function loadAccessContext(
  db: Executor,
  userId: string,
): Promise<AccessContext | null> {
  const result = await db.query<AccessRow>(
    `SELECT u.id::text,
            u.username,
            u.email,
            u.display_name,
            u.is_root,
            u.status,
            COALESCE(
              (SELECT array_agg(ur.role_slug ORDER BY ur.role_slug)
                 FROM clavis.user_roles ur
                WHERE ur.user_id = u.id),
              '{}'
            ) AS roles,
            CASE WHEN u.is_root THEN NULL
                 ELSE COALESCE(
                   (SELECT array_agg(effective.permission_key ORDER BY effective.permission_key)
                      FROM (
                        SELECT rp.permission_key
                          FROM clavis.user_roles ur
                          JOIN clavis.role_permissions rp ON rp.role_slug = ur.role_slug
                         WHERE ur.user_id = u.id
                        UNION
                        SELECT o.permission_key
                          FROM clavis.user_permission_overrides o
                         WHERE o.user_id = u.id AND o.effect = 'grant'
                        EXCEPT
                        SELECT o.permission_key
                          FROM clavis.user_permission_overrides o
                         WHERE o.user_id = u.id AND o.effect = 'revoke'
                      ) AS effective),
                   '{}'
                 )
            END AS permissions
       FROM clavis.users u
      WHERE u.id = $1`,
    [userId],
  )

  const row = result.rows[0]
  if (!row) return null

  return {
    user: {
      id: row.id,
      username: row.username,
      email: row.email,
      displayName: row.display_name,
      isRoot: row.is_root,
      status: row.status,
    },
    roles: row.roles,
    // Root gets the catalog from code; everyone else gets the DB result,
    // filtered so a key deleted from the catalog mid-window cannot leak.
    permissions: row.is_root
      ? [...PERMISSION_KEYS]
      : (row.permissions ?? []).filter(isPermissionKey),
  }
}

/** `true` when the context may exercise the permission (root bypasses). */
export function contextHasPermission(context: AccessContext, key: PermissionKey): boolean {
  return context.user.isRoot || context.permissions.includes(key)
}
