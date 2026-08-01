/**
 * Permission catalogue of the ERP. They map one to one to the *client roles* of
 * the `erp-api` client in Keycloak and arrive in the token under
 * `resource_access["erp-api"].roles`.
 */
export const PERMISSIONS = [
  'todos:read',
  'todos:read:all',
  'todos:write',
  'todos:delete',
  'users:read',
  'admin:manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** Authentication context attached to `request.auth`. */
export interface AuthContext {
  sub: string
  username: string
  email: string | null
  name: string | null
  realmRoles: string[]
  permissions: Permission[]
  token: string
}

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS)

/** Tells whether an arbitrary string is a known permission from the catalogue. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value)
}

/** Checks that the authenticated user holds a specific permission. */
export function hasPermission(auth: AuthContext, perm: Permission): boolean {
  return auth.permissions.includes(perm)
}

/** `true` if the user is allowed to see everybody's tasks. */
export function canSeeAllTodos(auth: AuthContext): boolean {
  return hasPermission(auth, 'todos:read:all')
}

/**
 * Extracts the permissions from the access token payload.
 * Reads `resource_access[audience].roles` and drops any role that is not part
 * of the `PERMISSIONS` catalogue.
 */
export function extractPermissions(tokenPayload: unknown, audience: string): Permission[] {
  if (typeof tokenPayload !== 'object' || tokenPayload === null) return []

  const resourceAccess = (tokenPayload as Record<string, unknown>)['resource_access']
  if (typeof resourceAccess !== 'object' || resourceAccess === null) return []

  const client = (resourceAccess as Record<string, unknown>)[audience]
  if (typeof client !== 'object' || client === null) return []

  const roles = (client as Record<string, unknown>)['roles']
  if (!Array.isArray(roles)) return []

  const found: Permission[] = []
  for (const role of roles) {
    if (isPermission(role) && !found.includes(role)) found.push(role)
  }
  return found
}

/** Extracts the realm roles (`realm_access.roles`) from the token payload. */
export function extractRealmRoles(tokenPayload: unknown): string[] {
  if (typeof tokenPayload !== 'object' || tokenPayload === null) return []

  const realmAccess = (tokenPayload as Record<string, unknown>)['realm_access']
  if (typeof realmAccess !== 'object' || realmAccess === null) return []

  const roles = (realmAccess as Record<string, unknown>)['roles']
  if (!Array.isArray(roles)) return []

  return roles.filter((role): role is string => typeof role === 'string')
}
