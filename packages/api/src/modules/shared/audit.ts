// Audit trail of the domain writes.
// It must never bring the request down: if the INSERT fails a warning is logged and we move on.
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'

/** Database access decorated on the Fastify instance. */
type Database = FastifyInstance['db']

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

/**
 * Inserts an audit row. Errors are caught and logged: the audit trail is
 * informative and must never break the response sent to the client.
 */
export async function recordAudit(
  db: Database,
  entry: AuditEntry,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
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
  } catch (err) {
    logger?.warn({ err, action: entry.action, entity: entry.entity }, 'Could not record the audit entry')
  }
}
