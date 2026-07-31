// Tipos de dominio compartidos y utilidades de lectura defensiva.
//
// La API es un sistema externo: en vez de castear su JSON a `any` leemos cada
// campo comprobando el tipo en runtime. Ademas aceptamos las variantes camelCase
// y snake_case para que un cambio de serializacion en la API no rompa la demo.

/* ------------------------------------------------------------------ */
/* Permisos (client roles de `erp-api`)                                */
/* ------------------------------------------------------------------ */

export const PERMISSIONS = [
  'todos:read',
  'todos:read:all',
  'todos:write',
  'todos:delete',
  'users:read',
  'admin:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}

export const PERMISSION_LABELS: Record<Permission, string> = {
  'todos:read': 'Ver sus tareas',
  'todos:read:all': 'Ver todas las tareas',
  'todos:write': 'Crear y editar',
  'todos:delete': 'Borrar tareas',
  'users:read': 'Ver usuarios',
  'admin:manage': 'Administrar',
}

/* ------------------------------------------------------------------ */
/* Roles de realm                                                      */
/* ------------------------------------------------------------------ */

export const REALM_ROLE_LABELS: Record<string, string> = {
  'erp-admin': 'Administrador',
  'erp-manager': 'Responsable',
  'erp-user': 'Usuario',
}

/** Roles tecnicos de Keycloak que no aportan nada al usuario final. */
const NOISY_REALM_ROLES: ReadonlySet<string> = new Set([
  'offline_access',
  'uma_authorization',
])

export function visibleRealmRoles(roles: readonly string[]): string[] {
  return roles.filter((role) => !NOISY_REALM_ROLES.has(role) && !role.startsWith('default-roles'))
}

/* ------------------------------------------------------------------ */
/* Estado y prioridad de las tareas                                    */
/* ------------------------------------------------------------------ */

export const TODO_STATUSES = ['todo', 'in_progress', 'done'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

const TODO_STATUS_SET: ReadonlySet<string> = new Set<string>(TODO_STATUSES)

export function isTodoStatus(value: string): value is TodoStatus {
  return TODO_STATUS_SET.has(value)
}

export const STATUS_LABELS: Record<TodoStatus, string> = {
  todo: 'Pendiente',
  in_progress: 'En curso',
  done: 'Completada',
}

export const PRIORITIES = [1, 2, 3, 4] as const
export type Priority = (typeof PRIORITIES)[number]

export const PRIORITY_LABELS: Record<Priority, string> = {
  1: 'Critica',
  2: 'Alta',
  3: 'Normal',
  4: 'Baja',
}

export function toPriority(value: number | null): Priority {
  switch (value) {
    case 1:
      return 1
    case 2:
      return 2
    case 4:
      return 4
    default:
      return 3
  }
}

/* ------------------------------------------------------------------ */
/* Lectura defensiva de JSON desconocido                               */
/* ------------------------------------------------------------------ */

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Devuelve el primer valor no vacio de entre varias claves candidatas. */
function firstDefined(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

export function readRecord(source: UnknownRecord, ...keys: string[]): UnknownRecord | null {
  const value = firstDefined(source, keys)
  return isRecord(value) ? value : null
}

export function readString(source: UnknownRecord, ...keys: string[]): string | null {
  const value = firstDefined(source, keys)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Acepta numeros y cadenas numericas (pg devuelve `bigint` como texto). */
export function readNumber(source: UnknownRecord, ...keys: string[]): number | null {
  const value = firstDefined(source, keys)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function readBoolean(source: UnknownRecord, ...keys: string[]): boolean {
  const value = firstDefined(source, keys)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  return false
}

export function readStringArray(source: UnknownRecord | null, ...keys: string[]): string[] {
  if (source === null) return []
  const value = firstDefined(source, keys)
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Acepta tanto `[...]` como `{ items: [...] }` / `{ data: [...] }`. */
export function readItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    for (const key of ['items', 'data', 'rows', 'results']) {
      const value = raw[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

/* ------------------------------------------------------------------ */
/* Formateo                                                            */
/* ------------------------------------------------------------------ */

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short',
  timeStyle: 'short',
})

const DATE_FORMAT = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' })

function toDate(value: string | null): Date | null {
  if (value === null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value: string | null): string {
  const date = toDate(value)
  return date === null ? '—' : DATE_TIME_FORMAT.format(date)
}

export function formatDate(value: string | null): string {
  const date = toDate(value)
  return date === null ? '—' : DATE_FORMAT.format(date)
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'B'
  const decimals = value >= 100 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(decimals)} ${unit}`
}

/** Iniciales para el avatar de la cabecera. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== '')
  const first = parts[0]
  if (first === undefined) return '?'
  const second = parts[1]
  const letters = second === undefined ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`
  return letters.toUpperCase()
}

/** Convierte `total_todos` o `totalTodos` en «Total todos» para tablas genericas. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase()
  if (spaced === '') return key
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
