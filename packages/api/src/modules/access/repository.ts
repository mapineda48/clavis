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

/**
 * The permission keys this user already holds as a `grant` override.
 *
 * The overrides write is a full replace and the UI re-sends the whole set, so a
 * grant already in this set is being *preserved*, not introduced: the actor is
 * not handing that capability out, and need not hold it. Only the grants not
 * already here are the newly handed-out ones `assertMayGrant` has to vet — the
 * same delta the role routes compute with `addedMembers`. Revokes never appear:
 * they take a capability away, which is the self check's business, not this
 * one's.
 */
export async function currentGrantKeys(db: Executor, userId: CanonicalUserId): Promise<string[]> {
  const result = await db.query<{ permission_key: string }>(
    `SELECT permission_key
       FROM clavis.user_permission_overrides
      WHERE user_id = $1 AND effect = 'grant'`,
    [userId],
  )
  return result.rows.map((row) => row.permission_key)
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
