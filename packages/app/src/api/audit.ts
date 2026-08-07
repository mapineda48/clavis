import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client'
import type { ApiError } from './client'
import { isRecord, readItems, readString } from '../lib/types'
import type { UnknownRecord } from '../lib/types'

export interface AuditEntry {
  id: string
  actorId: string | null
  actorUsername: string | null
  action: string
  entity: string
  entityId: string | null
  payload: unknown
  createdAt: string | null
}

// Runs inside the React Query `queryFn`, outside any hook.
export function normalizeAuditEntry(raw: unknown): AuditEntry {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  return {
    id: readString(record, 'id') ?? '',
    actorId: readString(record, 'actorId', 'actor_id'),
    actorUsername: readString(record, 'actorUsername', 'actor_username', 'actor'),
    action: readString(record, 'action') ?? '',
    entity: readString(record, 'entity') ?? '',
    entityId: readString(record, 'entityId', 'entity_id'),
    payload: record.payload,
    createdAt: readString(record, 'createdAt', 'created_at'),
  }
}

export const auditKeys = {
  list: (limit: number) => ['audit', limit] as const,
}

export function useAudit(limit: number, enabled: boolean) {
  return useQuery<AuditEntry[], ApiError>({
    queryKey: auditKeys.list(limit),
    queryFn: async () => {
      const raw = await apiFetch<unknown>(`/api/audit?limit=${String(limit)}`)
      return readItems(raw).map(normalizeAuditEntry)
    },
    enabled,
  })
}
