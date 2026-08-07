// Administration routes: provisioned users and audit trail.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ErrorResponse } from '../shared/schemas.js'

interface ListQueryInput {
  limit?: number
}

type AdminUserRow = {
  id: string
  username: string
  email: string | null
  display_name: string | null
  created_at: Date | string
  last_seen_at: Date | string | null
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
        },
        required: ['id', 'username', 'email', 'displayName', 'createdAt', 'lastSeenAt'],
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

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ListQueryInput }>(
    '/admin/users',
    {
      preHandler: [app.authenticate, app.requirePermissions('users:read')],
      schema: {
        tags: ['administration'],
        summary: 'Users provisioned in Clavis',
        description:
          'Lists the users created by the JIT provisioning that runs when a token is validated, ' +
          'together with their last access.',
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
                u.last_seen_at
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
