// Audit trail: read-only view over clavis.audit_log.
import type { FastifyPluginAsync } from 'fastify'
// Pulls in the @fastify/swagger type augmentation (tags, summary, security inside `schema`).
import type {} from '@fastify/swagger'
import { errorResponses } from '../shared/schemas.js'
import { toIso } from '../shared/serialize.js'

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

// No `total`: it used to be `items.length` after a LIMIT, which reports the
// page size as the collection size. A real total needs its own COUNT, and the
// listing needs a pagination policy before it needs one of those.
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
  },
  required: ['items'],
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
          ...errorResponses(401, 403),
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

      return { items }
    },
  )
}
