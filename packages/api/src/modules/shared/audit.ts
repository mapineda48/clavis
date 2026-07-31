// Registro de auditoria de las escrituras de dominio.
// Nunca debe tumbar la peticion: si falla el INSERT se registra un aviso y se sigue.
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'

/** Acceso a base de datos decorado en la instancia Fastify. */
type Database = FastifyInstance['db']

/** Entrada que se persiste en `erp.audit_log`. */
export interface AuditEntry {
  /** `sub` del usuario que ejecuta la accion (null en procesos internos). */
  actorId: string | null
  /** Accion en formato `entidad.verbo`, p. ej. `todo.created`. */
  action: string
  /** Entidad afectada, p. ej. `todo` o `attachment`. */
  entity: string
  /** Identificador de la entidad afectada. */
  entityId?: string | null
  /** Datos adicionales serializables a JSON. */
  payload?: Record<string, unknown>
}

/**
 * Inserta una fila de auditoria. Los errores se capturan y se registran:
 * la auditoria es informativa y jamas debe romper la respuesta al cliente.
 */
export async function recordAudit(
  db: Database,
  entry: AuditEntry,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO erp.audit_log (actor_id, action, entity, entity_id, payload)
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
    logger?.warn({ err, action: entry.action, entity: entry.entity }, 'No se pudo registrar la auditoria')
  }
}
