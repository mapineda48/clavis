import { PERMISSION_KEYS, type PermissionKey, isPermissionKey } from '@clavis/shared'
import { forbidden } from './errors.js'
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

/**
 * A user id in the exact spelling `clavis.users` stores it.
 *
 * The brand exists for one reason: `assertNotSelf` compares strings and
 * PostgreSQL compares uuids, and those are not the same comparison.
 * `'A1B2…'::uuid = 'a1b2…'::uuid` is true, as are the brace and unhyphenated
 * spellings, so a path parameter can address the caller's own row while a
 * string `!==` sees two different values — which is how a holder of
 * `access:manage` granted itself the whole catalog by uppercasing one letter of
 * its own id.
 *
 * Only a value the database handed back is branded (`row.id as CanonicalUserId`
 * inside a repository, and nowhere else), so passing `request.params.id`
 * straight to the self check is now a compile error rather than a silent
 * bypass. Nothing else about the type is special: it is a `string` everywhere a
 * `string` is wanted.
 */
export type CanonicalUserId = string & { readonly __brand: 'CanonicalUserId' }

/** Application-side view of a user row. */
export interface AccessUser {
  id: CanonicalUserId
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
      // `u.id::text` above: this is the canonical spelling, straight from the
      // column, which is the only thing the brand claims.
      id: row.id as CanonicalUserId,
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

/**
 * Refuses an operation a caller is aiming at their own account.
 *
 * `phrase` completes "You cannot …", so it carries the verb: `'change your own
 * roles or status'`, `'delete your own account'`. Every route that changes what
 * somebody may do calls this with the same code, `SELF_MODIFICATION`, so the
 * SPA and the verification suite recognise the refusal wherever it comes from.
 *
 * **This guards the removal direction.** Escalation — handing out a capability
 * — is `assertMayGrant`'s job, because that question is about the permission
 * set and not about identity. What is left here is the lockout direction:
 * revoking, disabling or deleting yourself, and the roles you would drop by
 * replacing your own set. Those take a second pair of hands.
 *
 * `targetId` is a `CanonicalUserId` on purpose: see the type. An identity-keyed
 * check is only as good as the identity it is given.
 */
export function assertNotSelf(actorId: string, targetId: CanonicalUserId, phrase: string): void {
  if (actorId !== targetId) return
  throw forbidden(`You cannot ${phrase}; another administrator has to.`, 'SELF_MODIFICATION')
}
