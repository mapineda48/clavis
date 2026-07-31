import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client'
import type { ApiError } from './client'
import {
  humanizeKey,
  isRecord,
  isTodoStatus,
  readItems,
  readNumber,
  readRecord,
  readString,
  PRIORITY_LABELS,
  STATUS_LABELS,
} from '../lib/types'
import type { UnknownRecord } from '../lib/types'

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

/** Fila generica «etiqueta → recuento» para las tablas de estadisticas. */
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
/* Normalizacion                                                       */
/* ------------------------------------------------------------------ */

const TOTALS_LABELS: Record<string, string> = {
  todos: 'Tareas',
  totalTodos: 'Tareas',
  total_todos: 'Tareas',
  users: 'Usuarios',
  totalUsers: 'Usuarios',
  total_users: 'Usuarios',
  attachments: 'Adjuntos',
  totalAttachments: 'Adjuntos',
  total_attachments: 'Adjuntos',
  auditEntries: 'Eventos de auditoria',
  audit_entries: 'Eventos de auditoria',
  activeUsers: 'Usuarios activos (7 d)',
  overdue: 'Vencidas',
  done: 'Completadas',
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Devuelve el primer valor presente entre varias claves, sea del tipo que sea. */
function pickValue(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function statusLabel(key: string): string {
  return isTodoStatus(key) ? STATUS_LABELS[key] : humanizeKey(key)
}

function priorityLabel(key: string): string {
  const value = Number(key)
  if (value === 1 || value === 2 || value === 3 || value === 4) {
    return `${value} · ${PRIORITY_LABELS[value]}`
  }
  return humanizeKey(key)
}

/**
 * Acepta tanto `[{ status, count }]` como `{ todo: 3, done: 1 }`, que son las
 * dos formas naturales de serializar la vista `erp.v_todo_stats`.
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
 * `GET /api/admin/stats` anida los conteos:
 * `{ todos: { total, byStatus, byPriority }, users: { total, activeLast7Days },
 *    attachments: { total, totalBytes }, cache: {...} }`.
 * Se lee esa forma y, como respaldo, un objeto plano con los conteos en la raiz.
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
    totals.push({ key, label: TOTALS_LABELS[key] ?? humanizeKey(key), count })
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
    username: readString(record, 'username', 'preferred_username') ?? '(sin usuario)',
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
