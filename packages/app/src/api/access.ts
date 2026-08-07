import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isPermissionKey, type PermissionKey } from '@clavis/shared'
import { apiFetch } from './client'
import type { ApiError } from './client'
import { meKeys } from './me'
import { userKeys } from './users'
import { isRecord, readString, readStringArray } from '../lib/types'
import type { UnknownRecord } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface CatalogPermission {
  key: PermissionKey
  module: string
  description: string
}

export interface Role {
  slug: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: PermissionKey[]
}

export interface Catalog {
  permissions: CatalogPermission[]
  roles: Role[]
}

export type OverrideEffect = 'grant' | 'revoke'

export interface Override {
  permissionKey: PermissionKey
  effect: OverrideEffect
}

export interface UserAccess {
  userId: string
  username: string
  isRoot: boolean
  roles: string[]
  overrides: Override[]
  effectivePermissions: PermissionKey[]
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function normalizeCatalog(raw: unknown): Catalog {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  const permissions: CatalogPermission[] = []
  if (Array.isArray(record['permissions'])) {
    for (const item of record['permissions']) {
      if (!isRecord(item)) continue
      const key = readString(item, 'key')
      if (key === null || !isPermissionKey(key)) continue
      permissions.push({
        key,
        module: readString(item, 'module') ?? '',
        description: readString(item, 'description') ?? '',
      })
    }
  }
  const roles: Role[] = []
  if (Array.isArray(record['roles'])) {
    for (const item of record['roles']) {
      if (!isRecord(item)) continue
      const slug = readString(item, 'slug')
      if (slug === null) continue
      roles.push({
        slug,
        name: readString(item, 'name') ?? slug,
        description: readString(item, 'description'),
        isSystem: item['isSystem'] === true,
        permissions: readStringArray(item, 'permissions').filter(isPermissionKey),
      })
    }
  }
  return { permissions, roles }
}

function normalizeOverrides(raw: unknown): Override[] {
  if (!Array.isArray(raw)) return []
  const overrides: Override[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const key = readString(item, 'permissionKey', 'permission_key')
    const effect = readString(item, 'effect')
    if (key === null || !isPermissionKey(key)) continue
    if (effect !== 'grant' && effect !== 'revoke') continue
    overrides.push({ permissionKey: key, effect })
  }
  return overrides
}

function normalizeUserAccess(raw: unknown): UserAccess {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  return {
    userId: readString(record, 'userId', 'user_id') ?? '',
    username: readString(record, 'username') ?? '',
    isRoot: record['isRoot'] === true,
    roles: readStringArray(record, 'roles'),
    overrides: normalizeOverrides(record['overrides']),
    effectivePermissions: readStringArray(record, 'effectivePermissions').filter(isPermissionKey),
  }
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export const accessKeys = {
  all: ['access'] as const,
  catalog: ['access', 'catalog'] as const,
  user: (id: string) => ['access', 'user', id] as const,
}

export function useCatalog(enabled = true) {
  return useQuery<Catalog, ApiError>({
    queryKey: accessKeys.catalog,
    queryFn: async () => normalizeCatalog(await apiFetch<unknown>('/api/access/catalog')),
    enabled,
  })
}

export function useUserAccess(userId: string | null) {
  return useQuery<UserAccess, ApiError>({
    queryKey: accessKeys.user(userId ?? 'none'),
    queryFn: async () =>
      normalizeUserAccess(
        await apiFetch<unknown>(`/api/access/users/${encodeURIComponent(userId ?? '')}`),
      ),
    enabled: userId !== null,
  })
}

/** Invalidation shared by every mutation of this module. */
function useInvalidateAccess() {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: accessKeys.all })
    await queryClient.invalidateQueries({ queryKey: userKeys.all })
    await queryClient.invalidateQueries({ queryKey: meKeys.me })
  }
}

export function useReplaceOverrides() {
  const invalidate = useInvalidateAccess()
  return useMutation<UserAccess, ApiError, { userId: string; overrides: Override[] }>({
    mutationFn: async ({ userId, overrides }) =>
      normalizeUserAccess(
        await apiFetch<unknown>(`/api/access/users/${encodeURIComponent(userId)}/overrides`, {
          method: 'PUT',
          body: JSON.stringify({ overrides }),
        }),
      ),
    onSuccess: invalidate,
  })
}

export interface CreateRoleInput {
  slug: string
  name: string
  description?: string
  permissions: PermissionKey[]
}

export function useCreateRole() {
  const invalidate = useInvalidateAccess()
  return useMutation<void, ApiError, CreateRoleInput>({
    mutationFn: async (input) => {
      await apiFetch<unknown>('/api/access/roles', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    },
    onSuccess: invalidate,
  })
}

export function useReplaceRolePermissions() {
  const invalidate = useInvalidateAccess()
  return useMutation<void, ApiError, { slug: string; permissions: PermissionKey[] }>({
    mutationFn: async ({ slug, permissions }) => {
      await apiFetch<unknown>(`/api/access/roles/${encodeURIComponent(slug)}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      })
    },
    onSuccess: invalidate,
  })
}

export function useDeleteRole() {
  const invalidate = useInvalidateAccess()
  return useMutation<void, ApiError, string>({
    mutationFn: async (slug) => {
      await apiFetch<unknown>(`/api/access/roles/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      })
    },
    onSuccess: invalidate,
  })
}
