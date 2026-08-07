import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { type AuditEntry, recordAudit } from '../modules/shared/audit.js'

/**
 * One domain write: the statements, the audit row that describes them and the
 * cache namespace they invalidate.
 */
export interface Mutation<T> {
  /** The write itself. Everything it does shares one transaction. */
  run(client: PoolClient): Promise<T>
  /** The audit entry, built from whatever `run` returned. */
  audit(result: T): AuditEntry
  /** Namespace to invalidate after COMMIT, or `null` when nothing derives from this write. */
  invalidate: string | null
}

/**
 * Runs a mutation, its audit row and its cache invalidation as one operation.
 *
 * The audit INSERT goes **inside the caller's transaction**. Before this, it
 * ran after the transaction had already committed and swallowed its own
 * errors, so the trail could silently miss a change that is permanently in the
 * database — the one failure mode an audit trail exists to rule out. They now
 * commit together or not at all.
 *
 * The cache bump happens **after COMMIT**, never before: bumping first opens a
 * window in which a concurrent request repopulates the new version with the
 * pre-commit state, which is exactly the staleness the bump exists to prevent.
 *
 * `invalidate` is required rather than optional so that adding a mutation
 * forces the author to decide. Forgetting the bump produces a bug that is
 * invisible for up to `CACHE_TTL_SECONDS` and then fixes itself.
 */
export async function mutate<T>(app: FastifyInstance, mutation: Mutation<T>): Promise<T> {
  const result = await app.db.tx(async (client) => {
    const value = await mutation.run(client)
    await recordAudit(client, mutation.audit(value))
    return value
  })

  if (mutation.invalidate !== null) {
    await app.cache.bumpVersion(mutation.invalidate)
  }
  return result
}
