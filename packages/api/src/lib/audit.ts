// Audit trail of the domain writes.
//
// The insert runs on the caller's executor and its errors PROPAGATE. Inside
// `lib/mutate.ts` that executor is the transaction client, so the audit row and
// the write it describes commit together or not at all: a trail that can
// silently miss a privileged change is not a trail. The trade is deliberate —
// an `audit_log` insert failure now fails the user's write, and in an
// access-control system an unaudited privileged write is the worse of the two.
//
// It lives in `lib/` rather than under `modules/` because `lib/mutate.ts` — the
// base every module's writes go through — depends on it, and the layering here
// is one-way: modules build on `lib`, never the reverse. From `modules/shared/`
// this one import inverted that for the whole project.
import type { Executor } from './executor.js'

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

/** The one logger method the best-effort variant needs. */
export interface AuditLogger {
  warn(obj: Record<string, unknown>, msg: string): void
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

/**
 * Same insert, but a failure is logged instead of propagated.
 *
 * Use it ONLY where the action being audited has already happened in another
 * system and cannot be undone, so there is no transaction for the audit row to
 * join and nothing a thrown error could roll back. `POST /users/:id/resend-invite`
 * is the one such caller: the invitation email is out. Failing the request
 * there turns a delivered invitation into a 500, and the obvious reaction to a
 * 500 is to press the button again — a second email for a first one that
 * worked. A missing audit row is the smaller loss, and it is logged.
 *
 * Everything that writes to the database goes through `lib/mutate.ts` and
 * `recordAudit` instead, where the row commits with the write it describes.
 */
export async function recordAuditBestEffort(
  db: Executor,
  entry: AuditEntry,
  log: AuditLogger,
): Promise<void> {
  try {
    await recordAudit(db, entry)
  } catch (error) {
    log.warn(
      { err: error, action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null },
      'The audit row could not be written; the action it describes already happened',
    )
  }
}
