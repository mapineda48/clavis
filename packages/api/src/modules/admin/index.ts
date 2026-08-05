// Administration routes: global statistics, provisioned users and audit trail.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ErrorResponse } from '../todos/schemas.js'
import { countByStatus } from '../todos/repository.js'

/** Cache version namespace of the todo listings. */
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
    generatedAt: { type: 'string', description: 'ISO 8601 instant the figures were computed at' },
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
      description: 'Rows exactly as the clavis.v_todo_stats view exposes them',
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
          lastSeenAt: { type: ['string', 'null'], description: 'Last time the user reached the API' },
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
      description: `Maximum number of records (1..${maxLimit})`,
    },
  },
})

/** Converts a pg timestamptz to ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** Same as `toIso` but tolerates nulls. */
function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value)
}

/**
 * Normalizes a generic row: pg bigints arrive as text and dates as Date, and
 * here they become numbers and ISO 8601 strings respectively.
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
        tags: ['administration'],
        summary: 'Global statistics',
        description:
          'Task counts per status and priority (including the clavis.v_todo_stats view), ' +
          'user and attachment totals, and the state of the cache.',
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
          'SELECT t.priority, count(*)::int AS total FROM clavis.todos t GROUP BY t.priority',
        ),
        app.db.query<UserStatsRow>(
          `SELECT count(*)::int AS total,
                  (count(*) FILTER (WHERE last_seen_at > now() - interval '7 days'))::int AS active_last_7_days
           FROM clavis.users`,
        ),
        app.db.query<AttachmentStatsRow>(
          `SELECT count(*)::int AS total, coalesce(sum(size_bytes), 0)::bigint AS total_bytes
           FROM clavis.todo_attachments`,
        ),
      ])

      // The view is informative: if it does not exist yet the admin panel still works.
      let statsView: Array<Record<string, unknown>> = []
      try {
        const view = await app.db.query<Record<string, unknown>>('SELECT * FROM clavis.v_todo_stats')
        statsView = view.rows.map(normalizeRow)
      } catch (err) {
        app.log.warn({ err }, 'Could not query the clavis.v_todo_stats view')
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
        app.log.warn({ err }, 'Could not read the cache status')
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
        tags: ['administration'],
        summary: 'Users provisioned in Clavis',
        description:
          'Lists the users created by the JIT provisioning that runs when a token is validated, ' +
          'with their last access and the number of tasks they own.',
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
                (SELECT count(*)::int FROM clavis.todos t WHERE t.owner_id = u.id) AS todo_count
         FROM clavis.users u
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
        tags: ['administration'],
        summary: 'Audit trail',
        description: 'Returns the latest entries recorded in clavis.audit_log, newest first.',
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
         FROM clavis.audit_log l
         LEFT JOIN clavis.users u ON u.id = l.actor_id
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
