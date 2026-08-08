// Response schema of the audit module and the serializer that produces it.
import { toIso } from '../shared/serialize.js'
import type { AuditRow } from './repository.js'

export interface ListQueryInput {
  limit?: number
}

export const ListAuditQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
}

// No `total`: it used to be `items.length` after a LIMIT, which reports the
// page size as the collection size. A real total needs its own COUNT, and the
// listing needs a pagination policy before it needs one of those.
export const AuditResponse = {
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

export function serializeAuditEntry(row: AuditRow) {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorUsername: row.actor_username,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}
