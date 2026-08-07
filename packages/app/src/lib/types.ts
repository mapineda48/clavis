// Shared domain types and defensive readers.
//
// The API is an external system: instead of casting its JSON to `any` we read
// every field checking the type at runtime. We also accept both the camelCase
// and the snake_case spelling so a serialisation change on the API side does
// not break the SPA.
//
// Labels are not stored here any more: a label depends on the active locale, so
// this module only maps a domain value to its translation key and lets the
// caller resolve it through `useI18n()` (or `translateActive()` outside React).

import { getActiveLocale } from '../i18n'
import type { Locale, TranslationKey } from '../i18n'

/* ------------------------------------------------------------------ */
/* Permissions (client roles of `clavis-api`)                             */
/* ------------------------------------------------------------------ */

export const PERMISSIONS = ['users:read', 'admin:manage'] as const

export type Permission = (typeof PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}

export const PERMISSION_LABEL_KEYS: Record<Permission, TranslationKey> = {
  'users:read': 'auth.permUsersRead',
  'admin:manage': 'auth.permAdminManage',
}

/* ------------------------------------------------------------------ */
/* Realm roles                                                         */
/* ------------------------------------------------------------------ */

export const REALM_ROLE_LABEL_KEYS: Record<string, TranslationKey> = {
  'clavis-admin': 'auth.roleAdmin',
  'clavis-manager': 'auth.roleManager',
  'clavis-user': 'auth.roleUser',
}

/** Technical Keycloak roles that mean nothing to the end user. */
const NOISY_REALM_ROLES: ReadonlySet<string> = new Set([
  'offline_access',
  'uma_authorization',
])

export function visibleRealmRoles(roles: readonly string[]): string[] {
  return roles.filter((role) => !NOISY_REALM_ROLES.has(role) && !role.startsWith('default-roles'))
}

/* ------------------------------------------------------------------ */
/* Defensive reading of unknown JSON                                   */
/* ------------------------------------------------------------------ */

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns the first non-empty value among several candidate keys. */
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

export function readStringArray(source: UnknownRecord | null, ...keys: string[]): string[] {
  if (source === null) return []
  const value = firstDefined(source, keys)
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Accepts both `[...]` and `{ items: [...] }` / `{ data: [...] }`. */
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
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * BCP 47 tag used for dates. `en-GB` keeps the day/month/year order, which is
 * also what the Spanish locale produces.
 */
const DATE_TAGS: Record<Locale, string> = {
  en: 'en-GB',
  es: 'es-ES',
}

// `Intl.DateTimeFormat` is expensive to build and the admin tables render one
// date per row, so keep one formatter per locale alive.
const dateTimeFormats = new Map<Locale, Intl.DateTimeFormat>()

function dateTimeFormatFor(locale: Locale): Intl.DateTimeFormat {
  const cached = dateTimeFormats.get(locale)
  if (cached !== undefined) return cached
  const format = new Intl.DateTimeFormat(DATE_TAGS[locale], {
    dateStyle: 'short',
    timeStyle: 'short',
  })
  dateTimeFormats.set(locale, format)
  return format
}

function toDate(value: string | null): Date | null {
  if (value === null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value: string | null, locale: Locale = getActiveLocale()): string {
  const date = toDate(value)
  return date === null ? '—' : dateTimeFormatFor(locale).format(date)
}

/** Initials for the avatar in the header. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part !== '')
  const first = parts[0]
  if (first === undefined) return '?'
  const second = parts[1]
  const letters = second === undefined ? first.slice(0, 2) : `${first.slice(0, 1)}${second.slice(0, 1)}`
  return letters.toUpperCase()
}
