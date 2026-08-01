import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client'
import type { ApiError } from './client'
import { translateActive } from '../i18n'
import type { TranslationKey } from '../i18n'
import {
  humanizeKey,
  isRecord,
  isTodoStatus,
  readItems,
  readNumber,
  readRecord,
  readString,
  PRIORITY_LABEL_KEYS,
  STATUS_LABEL_KEYS,
} from '../lib/types'
import type { UnknownRecord } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Generic “label → count” row for the statistics tables. */
export interface CountEntry {
  key: string
  label: string
  count: number
}

export interface AdminStats {
  totals: CountEntry[]
  byStatus: CountEntry[]
  byPriority: CountEntry[]
}

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

const TOTALS_LABEL_KEYS: Record<string, TranslationKey> = {
  todos: 'admin.totalTodos',
  totalTodos: 'admin.totalTodos',
  total_todos: 'admin.totalTodos',
  users: 'admin.totalUsers',
  totalUsers: 'admin.totalUsers',
  total_users: 'admin.totalUsers',
  attachments: 'admin.totalAttachments',
  totalAttachments: 'admin.totalAttachments',
  total_attachments: 'admin.totalAttachments',
  auditEntries: 'admin.totalAuditEntries',
  audit_entries: 'admin.totalAuditEntries',
  activeUsers: 'admin.totalActiveUsers',
  overdue: 'admin.totalOverdue',
  done: 'admin.totalDone',
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Returns the first present value among several keys, whatever its type. */
function pickValue(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** Falls back to `humanizeKey` for anything the API sends that we do not know. */
function totalsLabel(key: string): string {
  const labelKey = TOTALS_LABEL_KEYS[key]
  return labelKey === undefined ? humanizeKey(key) : translateActive(labelKey)
}

function statusLabel(key: string): string {
  return isTodoStatus(key) ? translateActive(STATUS_LABEL_KEYS[key]) : humanizeKey(key)
}

function priorityLabel(key: string): string {
  const value = Number(key)
  if (value === 1 || value === 2 || value === 3 || value === 4) {
    return translateActive('todo.priorityOption', {
      value,
      label: translateActive(PRIORITY_LABEL_KEYS[value]),
    })
  }
  return humanizeKey(key)
}

/**
 * Accepts both `[{ status, count }]` and `{ todo: 3, done: 1 }`, the two natural
 * ways of serialising the `erp.v_todo_stats` view.
 */
function toCountEntries(raw: unknown, labelFor: (key: string) => string): CountEntry[] {
  const entries: CountEntry[] = []
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!isRecord(row)) continue
      const key = readString(row, 'status', 'priority', 'key', 'name', 'label')
      if (key === null) continue
      entries.push({
        key,
        label: labelFor(key),
        count: readNumber(row, 'count', 'total', 'value', 'n') ?? 0,
      })
    }
    return entries
  }
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const count = toFiniteNumber(value)
      if (count === null) continue
      entries.push({ key, label: labelFor(key), count })
    }
  }
  return entries
}

/**
 * `GET /api/admin/stats` nests the counters:
 * `{ todos: { total, byStatus, byPriority }, users: { total, activeLast7Days },
 *    attachments: { total, totalBytes }, cache: {...} }`.
 * That shape is read first and, as a fallback, a flat object with the counters
 * at the root.
 */
export function normalizeStats(raw: unknown): AdminStats {
  const record: UnknownRecord = isRecord(raw) ? raw : {}
  const todosBlock = readRecord(record, 'todos')
  const usersBlock = readRecord(record, 'users')
  const attachmentsBlock = readRecord(record, 'attachments')
  const countsSource = todosBlock ?? record

  const totals: CountEntry[] = []
  const push = (key: string, count: number | null): void => {
    if (count === null) return
    totals.push({ key, label: totalsLabel(key), count })
  }

  const flatTotals = readRecord(record, 'totals', 'summary', 'counts')
  if (flatTotals !== null) {
    for (const [key, value] of Object.entries(flatTotals)) {
      push(key, toFiniteNumber(value))
    }
  } else {
    push('todos', readNumber(countsSource, 'total', 'totalTodos'))
    push('users', usersBlock === null ? null : readNumber(usersBlock, 'total'))
    push('activeUsers', usersBlock === null ? null : readNumber(usersBlock, 'activeLast7Days'))
    push('attachments', attachmentsBlock === null ? null : readNumber(attachmentsBlock, 'total'))
  }

  return {
    totals,
    byStatus: toCountEntries(
      pickValue(countsSource, ['byStatus', 'by_status', 'statuses', 'status']),
      statusLabel,
    ),
    byPriority: toCountEntries(
      pickValue(countsSource, ['byPriority', 'by_priority', 'priorities', 'priority']),
      priorityLabel,
    ),
  }
}

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
  stats: ['admin', 'stats'] as const,
  users: ['admin', 'users'] as const,
  audit: (limit: number) => ['admin', 'audit', limit] as const,
}

export function useAdminStats(enabled: boolean) {
  return useQuery<AdminStats, ApiError>({
    queryKey: adminKeys.stats,
    queryFn: async () => normalizeStats(await apiFetch<unknown>('/api/admin/stats')),
    enabled,
  })
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
