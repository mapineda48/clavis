import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client'
import type { ApiError } from './client'
import { translateActive } from '../i18n'
import { isRecord, readItems, readString } from '../lib/types'
import type { UnknownRecord } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AdminUser {
  id: string
  username: string
  email: string | null
  displayName: string | null
  createdAt: string | null
  lastSeenAt: string | null
}

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

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

// These normalisers run inside the React Query `queryFn`, outside any hook, so
// the labels come from `translateActive()`: they speak whatever language was
// active when the data was fetched.

export function normalizeUser(raw: unknown): AdminUser {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  return {
    id: readString(record, 'id', 'sub') ?? '',
    username:
      readString(record, 'username', 'preferred_username') ?? translateActive('admin.unknownUser'),
    email: readString(record, 'email'),
    displayName: readString(record, 'displayName', 'display_name', 'name'),
    createdAt: readString(record, 'createdAt', 'created_at'),
    lastSeenAt: readString(record, 'lastSeenAt', 'last_seen_at'),
  }
}

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

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export const adminKeys = {
  all: ['admin'] as const,
  users: ['admin', 'users'] as const,
  audit: (limit: number) => ['admin', 'audit', limit] as const,
}

export function useAdminUsers(enabled: boolean) {
  return useQuery<AdminUser[], ApiError>({
    queryKey: adminKeys.users,
    queryFn: async () => readItems(await apiFetch<unknown>('/api/admin/users')).map(normalizeUser),
    enabled,
  })
}

export function useAdminAudit(limit: number, enabled: boolean) {
  return useQuery<AuditEntry[], ApiError>({
    queryKey: adminKeys.audit(limit),
    queryFn: async () => {
      const raw = await apiFetch<unknown>(`/api/admin/audit?limit=${String(limit)}`)
      return readItems(raw).map(normalizeAuditEntry)
    },
    enabled,
  })
}
