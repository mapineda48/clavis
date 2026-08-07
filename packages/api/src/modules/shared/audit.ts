// Audit trail of the domain writes.
//
// The insert runs on the caller's executor and its errors PROPAGATE. Inside
// `lib/mutate.ts` that executor is the transaction client, so the audit row and
// the write it describes commit together or not at all: a trail that can
// silently miss a privileged change is not a trail. The trade is deliberate —
// an `audit_log` insert failure now fails the user's write, and in an
// access-control system an unaudited privileged write is the worse of the two.
import type { Executor } from '../../lib/executor.js'

/** Entry persisted into `clavis.audit_log`. */
export interface AuditEntry {
  /** `sub` of the user performing the action (null for internal processes). */
  actorId: string | null
  /** Action in `entity.verb` form, e.g. `todo.created`. */
  action: string
  /** Affected entity, e.g. `todo` or `attachment`. */
  entity: string
  /** Identifier of the affected entity. */
  entityId?: string | null
  /** Extra data, serializable to JSON. */
  payload?: Record<string, unknown>
}

/** Inserts an audit row on the caller's executor. Errors propagate. */
export async function recordAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO clavis.audit_log (actor_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      JSON.stringify(entry.payload ?? {}),
    ],
  )
}
