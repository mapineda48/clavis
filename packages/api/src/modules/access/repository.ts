// SQL layer of the access module. Handlers own the flow; this owns the queries.
//
// Every function here takes an `Executor` and never opens a transaction: the
// caller decides whether the statement runs on its own (`app.db`) or inside a
// transaction it already started (`client`). See `lib/executor.ts`.
import { type PermissionKey, isPermissionKey } from '@clavis/shared'
import type { CanonicalUserId } from '../../lib/access.js'
import type { Executor } from '../../lib/executor.js'

/** What the overrides route has to know about the user it is about to edit. */
export interface OverrideTarget {
  id: CanonicalUserId
  isRoot: boolean
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
 * keys, so the two `users:*` routes that write `user_roles` have to resolve the
 * roles into keys before they can ask it anything.
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
