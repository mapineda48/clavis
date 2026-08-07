// SQL layer of the access module. Handlers own the flow; this owns the queries.
//
// Every function here takes an `Executor` and never opens a transaction: the
// caller decides whether the statement runs on its own (`app.db`) or inside a
// transaction it already started (`client`). See `lib/executor.ts`.
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
