// SQL layer of the audit module: a read-only view over clavis.audit_log.
import type { Executor } from '../../lib/executor.js'

export interface AuditRow {
  id: string
  actor_id: string | null
  actor_username: string | null
  action: string
  entity: string
  entity_id: string | null
  payload: Record<string, unknown> | null
  created_at: Date | string
}

/** The latest entries, newest first. */
export async function listAuditEntries(db: Executor, limit: number): Promise<AuditRow[]> {
  const result = await db.query<AuditRow>(
    `SELECT l.id::text AS id,
            l.actor_id,
            u.username AS actor_username,
            l.action,
            l.entity,
            l.entity_id,
            l.payload,
            l.created_at
     FROM clavis.audit_log l
     LEFT JOIN clavis.users u ON u.id = l.actor_id
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $1`,
    [limit],
  )
  return result.rows
}
