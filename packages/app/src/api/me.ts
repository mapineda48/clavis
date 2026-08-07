import { useQuery } from '@tanstack/react-query'
import { isPermissionKey, type PermissionKey } from '@clavis/shared'
import { apiFetch } from './client'
import type { ApiError } from './client'
import { isRecord, readRecord, readString, readStringArray } from '../lib/types'
import type { UnknownRecord } from '../lib/types'

/** What /api/me answers: the application user behind the verified identity. */
export interface Me {
  user: {
    id: string
    username: string
    email: string | null
    displayName: string | null
    isRoot: boolean
    status: 'active' | 'disabled'
  }
  roles: string[]
  permissions: PermissionKey[]
}

export function normalizeMe(raw: unknown): Me {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  const user = readRecord(record, 'user') ?? {}
  return {
    user: {
      id: readString(user, 'id') ?? '',
      username: readString(user, 'username') ?? '',
      email: readString(user, 'email'),
      displayName: readString(user, 'displayName', 'display_name'),
      isRoot: user['isRoot'] === true,
      status: readString(user, 'status') === 'disabled' ? 'disabled' : 'active',
    },
    roles: readStringArray(record, 'roles'),
    permissions: readStringArray(record, 'permissions').filter(isPermissionKey),
  }
}

export const meKeys = {
  me: ['me'] as const,
}

/** The session profile; only runs once Keycloak has authenticated. */
export function useMe(enabled: boolean) {
  return useQuery<Me, ApiError>({
    queryKey: meKeys.me,
    queryFn: async () => normalizeMe(await apiFetch<unknown>('/api/me')),
    enabled,
    staleTime: 30_000,
  })
}
