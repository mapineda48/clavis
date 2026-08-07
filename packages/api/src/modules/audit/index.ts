// Audit trail: read-only view over clavis.audit_log.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { ErrorResponse } from '../shared/schemas.js'

interface ListQueryInput {
  limit?: number
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

/** Converts a pg timestamptz to ISO 8601. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ListQueryInput }>(
    '/audit',
    {
      preHandler: [app.authenticate, app.requirePermissions('audit:read')],
      schema: {
        tags: ['audit'],
        summary: 'Audit trail',
        description: 'Returns the latest entries recorded in clavis.audit_log, newest first.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
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
