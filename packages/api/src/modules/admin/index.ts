// Rutas de administracion: estadisticas globales, usuarios provisionados y auditoria.
import type { FastifyPluginAsync } from 'fastify'
// Carga la ampliacion de tipos de @fastify/swagger (tags, summary, security en `schema`).
import type {} from '@fastify/swagger'
import { ErrorResponse } from '../todos/schemas.js'
import { countByStatus } from '../todos/repository.js'

/** Namespace de version de cache de las listas de todos. */
const CACHE_NAMESPACE = 'todos'

interface ListQueryInput {
  limit?: number
}

type PriorityRow = {
  priority: number
  total: number
}

type UserStatsRow = {
  total: number
  active_last_7_days: number
}

type AttachmentStatsRow = {
  total: number
  total_bytes: string | number
}

type AdminUserRow = {
  id: string
  username: string
  email: string | null
  display_name: string | null
  created_at: Date | string
  last_seen_at: Date | string | null
  todo_count: number
}

type AuditRow = {
  id: string
  actor_id: string | null
  actor_username: string | null
  action: string
  entity: string
  entity_id: string | null
  payload: Record<string, unknown> | null
  created_at: Date | string
}

const StatsResponse = {
  type: 'object',
  properties: {
    generatedAt: { type: 'string', description: 'Instante ISO 8601 del calculo' },
    todos: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        byStatus: {
          type: 'object',
          properties: {
            todo: { type: 'integer' },
            in_progress: { type: 'integer' },
            done: { type: 'integer' },
          },
        },
        byPriority: {
          type: 'object',
          properties: {
            '1': { type: 'integer' },
            '2': { type: 'integer' },
            '3': { type: 'integer' },
            '4': { type: 'integer' },
          },
        },
      },
    },
    statsView: {
      type: 'array',
      description: 'Filas tal cual las expone la vista erp.v_todo_stats',
      items: { type: 'object', additionalProperties: true },
    },
    users: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        activeLast7Days: { type: 'integer' },
      },
    },
    attachments: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        totalBytes: { type: 'integer' },
      },
    },
    cache: {
      type: 'object',
      properties: {
        available: { type: 'boolean' },
        todosVersion: { type: ['integer', 'null'] },
      },
    },
  },
  required: ['generatedAt', 'todos', 'statsView', 'users', 'attachments', 'cache'],
}

const AdminUsersResponse = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          username: { type: 'string' },
          email: { type: ['string', 'null'] },
          displayName: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
          lastSeenAt: { type: ['string', 'null'], description: 'Ultimo acceso a la API' },
          todoCount: { type: 'integer' },
        },
        required: ['id', 'username', 'email', 'displayName', 'createdAt', 'lastSeenAt', 'todoCount'],
      },
    },
    total: { type: 'integer' },
  },
  required: ['items', 'total'],
}

const AuditResponse = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          actorId: { type: ['string', 'null'] },
          actorUsername: { type: ['string', 'null'] },
          action: { type: 'string' },
          entity: { type: 'string' },
          entityId: { type: ['string', 'null'] },
          payload: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string' },
        },
        required: ['id', 'actorId', 'actorUsername', 'action', 'entity', 'entityId', 'payload', 'createdAt'],
      },
    },
    total: { type: 'integer' },
  },
  required: ['items', 'total'],
}

const LimitQuery = (defaultLimit: number, maxLimit: number) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: maxLimit,
      default: defaultLimit,
      description: `Numero maximo de registros (1..${maxLimit})`,
    },
  },
})

/** Convierte un timestamptz de pg a ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Igual que `toIso` pero admite nulos. */
function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value)
}

/**
 * Normaliza una fila generica: los bigint de pg llegan como texto y las fechas
 * como Date, y aqui se convierten a numero e ISO 8601 respectivamente.
 */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      normalized[key] = value.toISOString()
    } else if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      normalized[key] = Number(value)
    } else {
      normalized[key] = value
    }
  }
  return normalized
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/stats',
    {
      preHandler: [app.authenticate, app.requirePermissions('admin:manage')],
      schema: {
        tags: ['administracion'],
        summary: 'Estadisticas globales del ERP',
        description:
          'Conteos de tareas por estado y prioridad (incluida la vista erp.v_todo_stats), ' +
          'totales de usuarios y adjuntos, y estado de la cache.',
        security: [{ bearerAuth: [] }],
        response: {
          200: StatsResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async () => {
      const [byStatus, priorities, users, attachments] = await Promise.all([
        countByStatus(app.db),
        app.db.query<PriorityRow>(
          'SELECT t.priority, count(*)::int AS total FROM erp.todos t GROUP BY t.priority',
        ),
        app.db.query<UserStatsRow>(
          `SELECT count(*)::int AS total,
                  (count(*) FILTER (WHERE last_seen_at > now() - interval '7 days'))::int AS active_last_7_days
           FROM erp.users`,
        ),
        app.db.query<AttachmentStatsRow>(
          `SELECT count(*)::int AS total, coalesce(sum(size_bytes), 0)::bigint AS total_bytes
           FROM erp.todo_attachments`,
        ),
      ])

      // La vista es informativa: si aun no existe no se tumba el panel de administracion.
      let statsView: Array<Record<string, unknown>> = []
      try {
        const view = await app.db.query<Record<string, unknown>>('SELECT * FROM erp.v_todo_stats')
        statsView = view.rows.map(normalizeRow)
      } catch (err) {
        app.log.warn({ err }, 'No se pudo consultar la vista erp.v_todo_stats')
      }

      const byPriority: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0 }
      for (const row of priorities.rows) {
        byPriority[String(row.priority)] = Number(row.total)
      }

      let cacheAvailable = false
      let todosVersion: number | null = null
      try {
        cacheAvailable = await app.cache.ping()
        todosVersion = await app.cache.version(CACHE_NAMESPACE)
      } catch (err) {
        app.log.warn({ err }, 'No se pudo consultar el estado de la cache')
      }

      const userStats = users.rows[0]
      const attachmentStats = attachments.rows[0]

      return {
        generatedAt: new Date().toISOString(),
        todos: {
          total: byStatus.todo + byStatus.in_progress + byStatus.done,
          byStatus,
          byPriority,
        },
        statsView,
        users: {
          total: Number(userStats?.total ?? 0),
          activeLast7Days: Number(userStats?.active_last_7_days ?? 0),
        },
        attachments: {
          total: Number(attachmentStats?.total ?? 0),
          totalBytes: Number(attachmentStats?.total_bytes ?? 0),
        },
        cache: { available: cacheAvailable, todosVersion },
      }
    },
  )

  app.get<{ Querystring: ListQueryInput }>(
    '/admin/users',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:read')],
      schema: {
        tags: ['administracion'],
        summary: 'Usuarios provisionados en el ERP',
        description:
          'Lista los usuarios creados por la provision JIT al validar el token, con su ultimo ' +
          'acceso y el numero de tareas de las que son propietarios.',
        security: [{ bearerAuth: [] }],
        querystring: LimitQuery(100, 500),
        response: {
          200: AdminUsersResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? 100
      const result = await app.db.query<AdminUserRow>(
        `SELECT u.id,
                u.username,
                u.email,
                u.display_name,
                u.created_at,
                u.last_seen_at,
                (SELECT count(*)::int FROM erp.todos t WHERE t.owner_id = u.id) AS todo_count
         FROM erp.users u
         ORDER BY u.last_seen_at DESC NULLS LAST, u.username ASC
         LIMIT $1`,
        [limit],
      )

      const items = result.rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        displayName: row.display_name,
        createdAt: toIso(row.created_at),
        lastSeenAt: toIsoOrNull(row.last_seen_at),
        todoCount: Number(row.todo_count),
      }))

      return { items, total: items.length }
    },
  )

  app.get<{ Querystring: ListQueryInput }>(
    '/admin/audit',
    {
      preHandler: [app.authenticate, app.requirePermissions('admin:manage')],
      schema: {
        tags: ['administracion'],
        summary: 'Registro de auditoria',
        description: 'Devuelve los ultimos movimientos registrados en erp.audit_log, de mas a menos reciente.',
        security: [{ bearerAuth: [] }],
        querystring: LimitQuery(50, 200),
        response: {
          200: AuditResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request) => {
      const limit = request.query.limit ?? 50
      const result = await app.db.query<AuditRow>(
        `SELECT l.id::text AS id,
                l.actor_id,
                u.username AS actor_username,
                l.action,
                l.entity,
                l.entity_id,
                l.payload,
                l.created_at
         FROM erp.audit_log l
         LEFT JOIN erp.users u ON u.id = l.actor_id
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $1`,
        [limit],
      )

      const items = result.rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorUsername: row.actor_username,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        payload: row.payload ?? {},
        createdAt: toIso(row.created_at),
      }))

      return { items, total: items.length }
    },
  )
}
