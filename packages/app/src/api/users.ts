import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './client'
import type { ApiError } from './client'
import { meKeys } from './me'
import { isRecord, readItems, readRecord, readString, readStringArray } from '../lib/types'
import type { UnknownRecord } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface SystemUser {
  id: string
  username: string
  email: string
  displayName: string | null
  isRoot: boolean
  status: 'active' | 'disabled'
  roles: string[]
  createdAt: string | null
  lastSeenAt: string | null
}

export interface InviteResult {
  sent: boolean
  reason: string | null
}

export type CredentialMode = 'temporary_password' | 'invite'

export interface CreateUserInput {
  email: string
  displayName: string
  username?: string
  roles: string[]
  credentialMode: CredentialMode
  temporaryPassword?: string
}

export interface UpdateUserInput {
  id: string
  displayName?: string
  status?: 'active' | 'disabled'
  roles?: string[]
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

export function normalizeUser(raw: unknown): SystemUser {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  return {
    id: readString(record, 'id') ?? '',
    username: readString(record, 'username') ?? '',
    email: readString(record, 'email') ?? '',
    displayName: readString(record, 'displayName', 'display_name'),
    isRoot: record['isRoot'] === true,
    status: readString(record, 'status') === 'disabled' ? 'disabled' : 'active',
    roles: readStringArray(record, 'roles'),
    createdAt: readString(record, 'createdAt', 'created_at'),
    lastSeenAt: readString(record, 'lastSeenAt', 'last_seen_at'),
  }
}

function normalizeInvite(raw: unknown): InviteResult {
  const record = isRecord(raw) ? (readRecord(raw, 'invite') ?? {}) : {}
  return {
    sent: record['sent'] === true,
    reason: readString(record, 'reason'),
  }
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export const userKeys = {
  all: ['users'] as const,
  list: ['users', 'list'] as const,
}

export function useUsers(enabled = true) {
  return useQuery<SystemUser[], ApiError>({
    queryKey: userKeys.list,
    queryFn: async () =>
      readItems(await apiFetch<unknown>('/api/users?limit=500')).map(normalizeUser),
    enabled,
  })
}

/** Invalidation shared by every mutation of this module. */
function useInvalidateUsers() {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: userKeys.all })
    // Permissions may have changed for the session user too.
    await queryClient.invalidateQueries({ queryKey: meKeys.me })
  }
}

export function useCreateUser() {
  const invalidate = useInvalidateUsers()
  return useMutation<{ user: SystemUser; invite: InviteResult }, ApiError, CreateUserInput>({
    mutationFn: async (input) => {
      const raw = await apiFetch<unknown>('/api/users', {
        method: 'POST',
        body: JSON.stringify(input),
      })
      const record: UnknownRecord = isRecord(raw) ? raw : {}
      return { user: normalizeUser(record['user']), invite: normalizeInvite(record) }
    },
    onSuccess: invalidate,
  })
}

export function useUpdateUser() {
  const invalidate = useInvalidateUsers()
  return useMutation<SystemUser, ApiError, UpdateUserInput>({
    mutationFn: async ({ id, ...changes }) => {
      const raw = await apiFetch<unknown>(`/api/users/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      })
      const record: UnknownRecord = isRecord(raw) ? raw : {}
      return normalizeUser(record['user'])
    },
    onSuccess: invalidate,
  })
}

export function useDeleteUser() {
  const invalidate = useInvalidateUsers()
  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      await apiFetch<unknown>(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
    onSuccess: invalidate,
  })
}

export function useResendInvite() {
  return useMutation<InviteResult, ApiError, string>({
    mutationFn: async (id) => {
      const raw = await apiFetch<unknown>(`/api/users/${encodeURIComponent(id)}/resend-invite`, {
        method: 'POST',
      })
      return normalizeInvite(raw)
    },
  })
}
